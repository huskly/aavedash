import {
  type AdjustedHFResult,
  type LoanPosition,
  computeAdjustedHF,
  computeRepaymentAmount,
  STABLECOIN_SYMBOLS,
  STABLECOIN_CONTRACTS,
} from '@aave-monitor/core';
import type { WatchdogConfig } from './storage.js';
import type { TelegramClient } from './telegram.js';

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

// Minimal ABI function selectors
const SELECTORS = {
  // withdraw(address asset, uint256 amount, address to) returns (uint256)
  withdraw: '0x69328dec',
  // repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)
  repay: '0x573ade81',
  // approve(address spender, uint256 amount) returns (bool)
  approve: '0x095ea7b3',
  // allowance(address owner, address spender) returns (uint256)
  allowance: '0xdd62ed3e',
} as const;

export type WatchdogLogEntry = {
  timestamp: number;
  loanId: string;
  wallet: string;
  action: 'dry-run' | 'repay' | 'withdraw+repay' | 'skipped';
  reason: string;
  adjustedHF: number;
  repayAmountUsd: number;
  txHashes?: string[];
};

type ExecuteRepayResult =
  | { status: 'executed'; walletSpent: number }
  | { status: 'skipped' }
  | { status: 'failed'; hadPartialExecution: boolean };

export class Watchdog {
  private cooldowns = new Map<string, number>();
  private readonly log: WatchdogLogEntry[] = [];
  private readonly maxLogEntries = 50;

  constructor(
    private readonly telegram: TelegramClient,
    private readonly getChatId: () => string | null,
    private readonly getConfig: () => WatchdogConfig,
    private readonly rpcUrl: string,
    private readonly privateKey: string | undefined,
  ) {}

  getLog(): WatchdogLogEntry[] {
    return [...this.log];
  }

  getStatusSummary(): {
    enabled: boolean;
    dryRun: boolean;
    hasPrivateKey: boolean;
    triggerHF: number;
    targetHF: number;
    recentActions: number;
  } {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      dryRun: config.dryRun,
      hasPrivateKey: Boolean(this.privateKey),
      triggerHF: config.triggerHF,
      targetHF: config.targetHF,
      recentActions: this.log.length,
    };
  }

  async evaluate(
    loan: LoanPosition,
    walletAddress: string,
    walletBalances: Map<string, number>,
  ): Promise<void> {
    const config = this.getConfig();

    if (!config.enabled) return;

    // Only handle stablecoin debt
    if (!STABLECOIN_SYMBOLS.has(loan.borrowed.symbol)) return;

    const adjusted = computeAdjustedHF(loan);

    if (adjusted.adjustedHF >= config.triggerHF) return;

    // Check cooldown
    const stateKey = `${walletAddress}-${loan.id}`;
    const lastAction = this.cooldowns.get(stateKey) ?? 0;
    const now = Date.now();
    if (now - lastAction < config.cooldownMs) {
      const remainingMs = config.cooldownMs - (now - lastAction);
      console.log(
        `[Watchdog] Cooldown active for ${stateKey}, skipping (${Math.round(remainingMs / 1000)}s remaining)`,
      );
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `Cooldown active: ${Math.round(remainingMs / 1000)}s remaining`,
        adjustedHF: adjusted.adjustedHF,
        repayAmountUsd: 0,
      });
      return;
    }

    const repayAmount = computeRepaymentAmount(
      config.targetHF,
      adjusted.adjustedCollateralUSD,
      adjusted.adjustedLt,
      adjusted.debt,
    );

    if (repayAmount <= 0) return;

    const cappedRepayUsd = Math.min(repayAmount, config.maxRepayUsd);
    // Since we're repaying stablecoins, amount ~= USD value
    const cappedRepayAmount = cappedRepayUsd;

    // Determine funding source
    const walletBalance = walletBalances.get(loan.borrowed.symbol) ?? 0;
    const needFromWithdraw = Math.max(0, cappedRepayAmount - walletBalance);
    const withdrawAmount = Math.min(needFromWithdraw, adjusted.sameAssetSuppliedAmount);
    const totalAvailable = walletBalance + withdrawAmount;
    const actualRepayAmount = Math.min(cappedRepayAmount, totalAvailable);

    if (actualRepayAmount <= 0.01) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `Insufficient funds: wallet=${walletBalance.toFixed(2)}, withdrawable=${adjusted.sameAssetSuppliedAmount.toFixed(2)}`,
        adjustedHF: adjusted.adjustedHF,
        repayAmountUsd: 0,
      });
      await this.notify(
        `\u{1F6A8} <b>Watchdog: Insufficient funds</b>\n\n` +
          `Loan ${loan.id} needs ${cappedRepayUsd.toFixed(2)} ${loan.borrowed.symbol} repayment\n` +
          `Wallet: ${walletBalance.toFixed(2)} ${loan.borrowed.symbol}\n` +
          `Withdrawable: ${adjusted.sameAssetSuppliedAmount.toFixed(2)} ${loan.borrowed.symbol}\n` +
          `Adjusted HF: ${adjusted.adjustedHF.toFixed(4)}`,
      );
      return;
    }

    if (config.dryRun) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'dry-run',
        reason:
          `Would repay ${actualRepayAmount.toFixed(2)} ${loan.borrowed.symbol}` +
          (withdrawAmount > 0 ? ` (withdraw ${withdrawAmount.toFixed(2)} first)` : ''),
        adjustedHF: adjusted.adjustedHF,
        repayAmountUsd: actualRepayAmount,
      });
      this.cooldowns.set(stateKey, now);

      await this.notify(
        `\u{1F9EA} <b>Watchdog DRY RUN</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `Adjusted HF: <b>${adjusted.adjustedHF.toFixed(4)}</b> (trigger: ${config.triggerHF})\n` +
          `Target HF: ${config.targetHF}\n\n` +
          `Would repay: <b>${actualRepayAmount.toFixed(2)} ${loan.borrowed.symbol}</b>\n` +
          (withdrawAmount > 0
            ? `Would withdraw: ${withdrawAmount.toFixed(2)} ${loan.borrowed.symbol}\n`
            : '') +
          `Wallet balance: ${walletBalance.toFixed(2)} ${loan.borrowed.symbol}`,
      );
      return;
    }

    // Live mode
    if (!this.privateKey) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: 'No private key configured for live execution',
        adjustedHF: adjusted.adjustedHF,
        repayAmountUsd: 0,
      });
      return;
    }

    const result = await this.executeRepay(
      loan,
      walletAddress,
      adjusted,
      actualRepayAmount,
      withdrawAmount,
      config,
    );

    if (result.status === 'executed') {
      this.cooldowns.set(stateKey, Date.now());

      // Update wallet balances only when repay executed successfully.
      const currentBalance = walletBalances.get(loan.borrowed.symbol) ?? 0;
      walletBalances.set(loan.borrowed.symbol, Math.max(0, currentBalance - result.walletSpent));
      return;
    }

    // Keep cooldown after partial execution (e.g. withdraw succeeded, repay failed)
    // to avoid immediate retries while on-chain state settles.
    if (result.status === 'failed' && result.hadPartialExecution) {
      this.cooldowns.set(stateKey, Date.now());
    }
  }

  private async executeRepay(
    loan: LoanPosition,
    walletAddress: string,
    adjusted: AdjustedHFResult,
    repayAmount: number,
    withdrawAmount: number,
    config: WatchdogConfig,
  ): Promise<ExecuteRepayResult> {
    const now = Date.now();
    const txHashes: string[] = [];
    const symbol = loan.borrowed.symbol;
    const contract = STABLECOIN_CONTRACTS[symbol];
    if (!contract) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `Unknown stablecoin contract for ${symbol}`,
        adjustedHF: adjusted.adjustedHF,
        repayAmountUsd: 0,
      });
      return { status: 'skipped' };
    }

    try {
      // Check gas price
      const gasPrice = await this.getGasPrice();
      const gasPriceGwei = gasPrice / 1e9;
      if (gasPriceGwei > config.maxGasGwei) {
        this.addLog({
          timestamp: now,
          loanId: loan.id,
          wallet: walletAddress,
          action: 'skipped',
          reason: `Gas price ${gasPriceGwei.toFixed(1)} gwei exceeds max ${config.maxGasGwei} gwei`,
          adjustedHF: adjusted.adjustedHF,
          repayAmountUsd: repayAmount,
        });
        await this.notify(
          `\u{26FD} <b>Watchdog: Gas too high</b>\n\n` +
            `Current: ${gasPriceGwei.toFixed(1)} gwei (max: ${config.maxGasGwei})\n` +
            `Skipping repayment of ${repayAmount.toFixed(2)} ${symbol}`,
        );
        return { status: 'skipped' };
      }

      // Check ETH balance for gas
      const ethBalance = await this.getEthBalance(walletAddress);
      if (ethBalance < 0.005) {
        this.addLog({
          timestamp: now,
          loanId: loan.id,
          wallet: walletAddress,
          action: 'skipped',
          reason: `Insufficient ETH for gas: ${ethBalance.toFixed(6)} ETH`,
          adjustedHF: adjusted.adjustedHF,
          repayAmountUsd: repayAmount,
        });
        await this.notify(
          `\u{26FD} <b>Watchdog: Insufficient ETH for gas</b>\n\n` +
            `Balance: ${ethBalance.toFixed(6)} ETH\n` +
            `Skipping repayment of ${repayAmount.toFixed(2)} ${symbol}`,
        );
        return { status: 'skipped' };
      }

      const repayRaw = amountToHex(repayAmount, contract.decimals);

      // Step 1: Withdraw same-asset supply if needed
      if (withdrawAmount > 0) {
        const withdrawRaw = amountToHex(withdrawAmount, contract.decimals);
        const withdrawData = encodeFunctionCall(SELECTORS.withdraw, [
          contract.address,
          withdrawRaw,
          walletAddress,
        ]);
        const withdrawTx = await this.sendTransaction(walletAddress, AAVE_V3_POOL, withdrawData);
        txHashes.push(withdrawTx);
        console.log(`[Watchdog] Withdraw tx: ${withdrawTx}`);
      }

      // Step 2: Check/set ERC20 allowance
      const allowance = await this.getAllowance(contract.address, walletAddress, AAVE_V3_POOL);
      const repayRawBigInt = BigInt(repayRaw);
      if (allowance < repayRawBigInt) {
        const maxApproval = '0x' + 'f'.repeat(64);
        const approveData = encodeFunctionCall(SELECTORS.approve, [AAVE_V3_POOL, maxApproval]);
        const approveTx = await this.sendTransaction(walletAddress, contract.address, approveData);
        txHashes.push(approveTx);
        console.log(`[Watchdog] Approve tx: ${approveTx}`);
      }

      // Step 3: Repay
      const interestRateMode = '0x' + '2'.padStart(64, '0'); // variable rate
      const repayData = encodeFunctionCall(SELECTORS.repay, [
        contract.address,
        repayRaw,
        interestRateMode,
        walletAddress,
      ]);
      const repayTx = await this.sendTransaction(walletAddress, AAVE_V3_POOL, repayData);
      txHashes.push(repayTx);
      console.log(`[Watchdog] Repay tx: ${repayTx}`);

      const action = withdrawAmount > 0 ? 'withdraw+repay' : 'repay';
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action,
        reason: `Repaid ${repayAmount.toFixed(2)} ${symbol}`,
        adjustedHF: adjusted.adjustedHF,
        repayAmountUsd: repayAmount,
        txHashes,
      });

      await this.notify(
        `\u{2705} <b>Watchdog: Repayment executed</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `Repaid: <b>${repayAmount.toFixed(2)} ${symbol}</b>\n` +
          (withdrawAmount > 0 ? `Withdrew: ${withdrawAmount.toFixed(2)} ${symbol}\n` : '') +
          `Adjusted HF was: ${adjusted.adjustedHF.toFixed(4)}\n` +
          `Tx: ${txHashes.map((h) => `<code>${h}</code>`).join('\n')}`,
      );
      return { status: 'executed', walletSpent: Math.max(0, repayAmount - withdrawAmount) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `Execution failed: ${message}`,
        adjustedHF: adjusted.adjustedHF,
        repayAmountUsd: repayAmount,
        txHashes: txHashes.length > 0 ? txHashes : undefined,
      });
      await this.notify(
        `\u{274C} <b>Watchdog: Execution failed</b>\n\n` +
          `Loan: ${loan.id}\n` +
          `Error: ${message}\n` +
          (txHashes.length > 0
            ? `Partial txs: ${txHashes.map((h) => `<code>${h}</code>`).join('\n')}`
            : ''),
      );
      return { status: 'failed', hadPartialExecution: txHashes.length > 0 };
    }
  }

  private async getGasPrice(): Promise<number> {
    const result = await this.rpcCall<string>('eth_gasPrice', []);
    return Number(BigInt(result));
  }

  private async getEthBalance(address: string): Promise<number> {
    const result = await this.rpcCall<string>('eth_getBalance', [address, 'latest']);
    return Number(BigInt(result)) / 1e18;
  }

  private async getAllowance(token: string, owner: string, spender: string): Promise<bigint> {
    const data = SELECTORS.allowance + padAddress(owner) + padAddress(spender);
    const result = await this.rpcCall<string>('eth_call', [{ to: token, data }, 'latest']);
    return BigInt(result);
  }
  private walletPromise?: Promise<import('ethers').Wallet>;

  private async sendTransaction(from: string, to: string, data: string): Promise<string> {
    if (!this.privateKey) {
      throw new Error('No private key configured');
    }

    if (!this.walletPromise) {
      this.walletPromise = (async () => {
        const { Wallet, JsonRpcProvider } = await import('ethers');
        const provider = new JsonRpcProvider(this.rpcUrl);
        return new Wallet(this.privateKey!, provider);
      })();
    }

    const wallet = await this.walletPromise;
    const signerAddress = wallet.address;
    if (signerAddress.toLowerCase() !== from.toLowerCase()) {
      throw new Error(
        `Signer address mismatch: private key controls ${signerAddress} but expected ${from}. ` +
          `The configured private key must correspond to the monitored wallet address.`,
      );
    }

    const tx = await wallet.sendTransaction({ to, data });
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      throw new Error(`Transaction reverted: ${tx.hash}`);
    }
    return tx.hash;
  }

  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`RPC request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      result?: T;
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(`RPC error: ${data.error.message}`);
    }

    return data.result as T;
  }

  private async notify(message: string): Promise<void> {
    const chatId = this.getChatId();
    if (chatId) {
      await this.telegram.sendMessage(chatId, message);
    }
  }

  private addLog(entry: WatchdogLogEntry): void {
    this.log.unshift(entry);
    if (this.log.length > this.maxLogEntries) {
      this.log.length = this.maxLogEntries;
    }
    console.log(
      `[Watchdog] ${entry.action}: ${entry.reason} (loan=${entry.loanId}, adjHF=${entry.adjustedHF.toFixed(4)})`,
    );
  }
}

function padAddress(address: string): string {
  return address.toLowerCase().replace('0x', '').padStart(64, '0');
}

function amountToHex(amount: number, decimals: number): string {
  // Use string-based conversion to avoid floating point precision issues
  const fixed = amount.toFixed(decimals);
  const [integerPart, fractionalPartRaw = ''] = fixed.split('.');
  const fractionalPart = fractionalPartRaw.padEnd(decimals, '0').slice(0, decimals);
  const rawStr = integerPart + fractionalPart;
  const raw = BigInt(rawStr);
  return '0x' + raw.toString(16).padStart(64, '0');
}

function encodeFunctionCall(selector: string, params: string[]): string {
  const encodedParams = params.map((p) => {
    if (p.startsWith('0x') && p.length === 66) {
      // Already a 32-byte padded value
      return p.slice(2);
    }
    if (p.startsWith('0x') && p.length === 42) {
      // Address — left-pad to 32 bytes
      return padAddress(p);
    }
    // Assume it's already a padded hex string
    return p.replace('0x', '').padStart(64, '0');
  });
  return selector + encodedParams.join('');
}
