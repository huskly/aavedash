import { computeLoanMetrics, DEFAULT_R_DEPLOY, type LoanPosition } from '@aave-monitor/core';
import { formatUnits, Interface, JsonRpcProvider, parseUnits, Wallet } from 'ethers';
import type { WatchdogConfig } from './storage.js';
import type { TelegramClient } from './telegram.js';
import { logger } from './logger.js';

const WBTC_CONTRACT = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
const WBTC_DECIMALS = 8;

const ERC20_INTERFACE = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const RESCUE_INTERFACE = new Interface([
  'function rescue((address user,address asset,uint256 amount,uint256 minResultingHF,uint256 deadline) params)',
  'function previewResultingHF(address user, address asset, uint256 amount) view returns (uint256)',
]);

const MIN_ETH_FOR_GAS = 0.005;
export type WatchdogLogEntry = {
  timestamp: number;
  loanId: string;
  wallet: string;
  action: 'dry-run' | 'rescue' | 'skipped';
  reason: string;
  healthFactor: number;
  topUpWbtc: number;
  projectedHF: number;
  txHash?: string;
};

export class Watchdog {
  private cooldowns = new Map<string, number>();
  private readonly log: WatchdogLogEntry[] = [];
  private readonly maxLogEntries = 50;
  private provider?: JsonRpcProvider;
  private wallet?: Wallet;

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
    minResultingHF: number;
    rescueContract: string;
    recentActions: number;
  } {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      dryRun: config.dryRun,
      hasPrivateKey: Boolean(this.privateKey),
      triggerHF: config.triggerHF,
      targetHF: config.targetHF,
      minResultingHF: config.minResultingHF,
      rescueContract: config.rescueContract,
      recentActions: this.log.length,
    };
  }

  async evaluate(loan: LoanPosition, walletAddress: string): Promise<void> {
    const config = this.getConfig();

    if (!config.enabled) return;

    const healthFactor = computeLoanMetrics(loan, DEFAULT_R_DEPLOY).healthFactor;
    if (!Number.isFinite(healthFactor) || healthFactor >= config.triggerHF) {
      return;
    }

    const rescueContract = config.rescueContract.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(rescueContract)) {
      this.addLog({
        timestamp: Date.now(),
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: 'Invalid or missing rescueContract in watchdog config',
        healthFactor,
        topUpWbtc: 0,
        projectedHF: healthFactor,
      });
      return;
    }

    const now = Date.now();
    const stateKey = `${walletAddress}-${loan.id}`;
    const lastAction = this.cooldowns.get(stateKey) ?? 0;
    if (now - lastAction < config.cooldownMs) {
      const remainingMs = config.cooldownMs - (now - lastAction);
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `Cooldown active: ${Math.round(remainingMs / 1000)}s remaining`,
        healthFactor,
        topUpWbtc: 0,
        projectedHF: healthFactor,
      });
      return;
    }

    let topUpWbtc: number;
    let projectedHF: number;
    let amountRaw: bigint;
    const provider = this.getProvider();
    const minHFWad = this.toWad(config.minResultingHF);

    try {
      const [walletBalanceRaw, allowanceRaw] = await Promise.all([
        this.getTokenBalance(provider, WBTC_CONTRACT, walletAddress),
        this.getTokenAllowance(provider, WBTC_CONTRACT, walletAddress, rescueContract),
      ]);

      const maxTopUpRaw = parseUnits(config.maxTopUpWbtc.toFixed(WBTC_DECIMALS), WBTC_DECIMALS);
      const availableRaw = minBigInt(walletBalanceRaw, allowanceRaw, maxTopUpRaw);
      if (availableRaw <= 0n) {
        this.addLog({
          timestamp: now,
          loanId: loan.id,
          wallet: walletAddress,
          action: 'skipped',
          reason: 'No available WBTC (balance/allowance/maxTopUp all exhausted)',
          healthFactor,
          topUpWbtc: 0,
          projectedHF: healthFactor,
        });
        await this.notify(
          `🚨 <b>Watchdog: WBTC unavailable</b>\n\n` +
            `Loan: ${loan.id} (${loan.marketName})\n` +
            `HF: <b>${healthFactor.toFixed(4)}</b>\n` +
            `Wallet WBTC: ${formatUnits(walletBalanceRaw, WBTC_DECIMALS)}\n` +
            `Allowance WBTC: ${formatUnits(allowanceRaw, WBTC_DECIMALS)}`,
        );
        return;
      }

      const targetHFWad = this.toWad(config.targetHF);

      let computedAmount = await this.findRequiredAmountRaw(
        provider,
        rescueContract,
        walletAddress,
        targetHFWad,
        availableRaw,
      );

      if (computedAmount === null) {
        computedAmount = await this.findRequiredAmountRaw(
          provider,
          rescueContract,
          walletAddress,
          minHFWad,
          availableRaw,
        );
      }

      if (computedAmount === null || computedAmount <= 0n) {
        this.addLog({
          timestamp: now,
          loanId: loan.id,
          wallet: walletAddress,
          action: 'skipped',
          reason: 'Insufficient WBTC to achieve minimum resulting HF',
          healthFactor,
          topUpWbtc: 0,
          projectedHF: healthFactor,
        });
        await this.notify(
          `🚨 <b>Watchdog: Rescue not feasible</b>\n\n` +
            `Loan: ${loan.id} (${loan.marketName})\n` +
            `Current HF: <b>${healthFactor.toFixed(4)}</b>\n` +
            `Max usable WBTC: ${formatUnits(availableRaw, WBTC_DECIMALS)}\n` +
            `Min resulting HF: ${config.minResultingHF}`,
        );
        return;
      }

      amountRaw = computedAmount;

      const projectedHFWad = await this.previewResultingHF(
        provider,
        rescueContract,
        walletAddress,
        amountRaw,
      );

      if (projectedHFWad < minHFWad) {
        this.addLog({
          timestamp: now,
          loanId: loan.id,
          wallet: walletAddress,
          action: 'skipped',
          reason: 'Projected HF below minimum resulting HF threshold',
          healthFactor,
          topUpWbtc: this.toNumberAmount(amountRaw),
          projectedHF: this.wadToNumber(projectedHFWad),
        });
        return;
      }

      topUpWbtc = this.toNumberAmount(amountRaw);
      projectedHF = this.wadToNumber(projectedHFWad);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `On-chain call failed: ${message}`,
        healthFactor,
        topUpWbtc: 0,
        projectedHF: healthFactor,
      });
      await this.notify(
        `❌ <b>Watchdog: On-chain call failed</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `HF: <b>${healthFactor.toFixed(4)}</b>\n` +
          `Error: ${message}`,
      );
      return;
    }

    if (config.dryRun) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'dry-run',
        reason: `Would submit atomic rescue with ${topUpWbtc.toFixed(8)} WBTC`,
        healthFactor,
        topUpWbtc,
        projectedHF,
      });
      this.cooldowns.set(stateKey, now);
      await this.notify(
        `🧪 <b>Watchdog DRY RUN</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `Current HF: <b>${healthFactor.toFixed(4)}</b> (trigger: ${config.triggerHF})\n` +
          `Target HF: ${config.targetHF}\n` +
          `Min resulting HF: ${config.minResultingHF}\n\n` +
          `Would top-up: <b>${topUpWbtc.toFixed(8)} WBTC</b>\n` +
          `Projected HF: <b>${projectedHF.toFixed(4)}</b>`,
      );
      return;
    }

    if (!this.privateKey) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: 'No private key configured for live rescue execution',
        healthFactor,
        topUpWbtc,
        projectedHF,
      });
      return;
    }

    const gasPriceGwei = await this.getGasPriceGwei(provider);
    if (gasPriceGwei > config.maxGasGwei) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `Gas price ${gasPriceGwei.toFixed(1)} gwei exceeds max ${config.maxGasGwei} gwei`,
        healthFactor,
        topUpWbtc,
        projectedHF,
      });
      await this.notify(
        `⛽ <b>Watchdog: Gas too high</b>\n\n` +
          `Current: ${gasPriceGwei.toFixed(1)} gwei (max: ${config.maxGasGwei})\n` +
          `Skipping rescue for ${topUpWbtc.toFixed(8)} WBTC`,
      );
      return;
    }

    const ethBalance = await this.getEthBalance(provider, walletAddress);
    if (ethBalance < MIN_ETH_FOR_GAS) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `Insufficient ETH for gas: ${ethBalance.toFixed(6)} ETH`,
        healthFactor,
        topUpWbtc,
        projectedHF,
      });
      await this.notify(
        `⛽ <b>Watchdog: Insufficient ETH for gas</b>\n\n` +
          `Balance: ${ethBalance.toFixed(6)} ETH\n` +
          `Skipping rescue for ${topUpWbtc.toFixed(8)} WBTC`,
      );
      return;
    }

    const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
    try {
      const txHash = await this.submitRescueTransaction(
        walletAddress,
        rescueContract,
        amountRaw,
        minHFWad,
        deadline,
      );

      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'rescue',
        reason: `Rescue submitted with ${topUpWbtc.toFixed(8)} WBTC`,
        healthFactor,
        topUpWbtc,
        projectedHF,
        txHash,
      });
      this.cooldowns.set(stateKey, Date.now());

      await this.notify(
        `✅ <b>Watchdog: Atomic rescue executed</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `Top-up: <b>${topUpWbtc.toFixed(8)} WBTC</b>\n` +
          `Projected HF: <b>${projectedHF.toFixed(4)}</b>\n` +
          `Tx: <code>${txHash}</code>`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        action: 'skipped',
        reason: `Rescue tx failed: ${message}`,
        healthFactor,
        topUpWbtc,
        projectedHF,
      });
      this.cooldowns.set(stateKey, Date.now());

      await this.notify(
        `❌ <b>Watchdog: Rescue failed</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `Top-up attempted: <b>${topUpWbtc.toFixed(8)} WBTC</b>\n` +
          `Error: ${message}`,
      );
    }
  }

  private async findRequiredAmountRaw(
    provider: JsonRpcProvider,
    rescueContract: string,
    user: string,
    targetHF: bigint,
    maxAmount: bigint,
  ): Promise<bigint | null> {
    if (maxAmount <= 0n) return null;

    // HF is linear in amount: HF(a) = currentHF + slope * a
    // Two points (amount=0, amount=maxAmount) determine the line exactly.
    const [currentHF, maxHF] = await Promise.all([
      this.previewResultingHF(provider, rescueContract, user, 0n),
      this.previewResultingHF(provider, rescueContract, user, maxAmount),
    ]);

    if (currentHF >= targetHF) return 0n;
    if (maxHF < targetHF) return null;

    // Linear interpolation: amount = maxAmount * (targetHF - currentHF) / (maxHF - currentHF)
    // Add 1 to round up so we meet the target rather than falling just short.
    const numerator = maxAmount * (targetHF - currentHF);
    const denominator = maxHF - currentHF;
    const estimate = numerator / denominator + 1n;
    const clamped = estimate > maxAmount ? maxAmount : estimate;

    // Verify the estimate with a single confirmation call
    const verifiedHF = await this.previewResultingHF(provider, rescueContract, user, clamped);
    if (verifiedHF >= targetHF) return clamped;

    // Estimate undershot (oracle drift between preview calls). Refine once: interpolate
    // between the undershot estimate (verifiedHF) and maxAmount (maxHF) to avoid
    // falling back to the full maxAmount unnecessarily.
    if (verifiedHF < targetHF && maxHF > verifiedHF) {
      const gap = maxAmount - clamped;
      const refinedEstimate = clamped + (gap * (targetHF - verifiedHF)) / (maxHF - verifiedHF) + 1n;
      const refinedClamped = refinedEstimate > maxAmount ? maxAmount : refinedEstimate;
      const refinedHF = await this.previewResultingHF(
        provider,
        rescueContract,
        user,
        refinedClamped,
      );
      if (refinedHF >= targetHF) return refinedClamped;
    }

    // Last resort: use maxAmount since we already know it achieves the target.
    return maxAmount;
  }

  private async previewResultingHF(
    provider: JsonRpcProvider,
    rescueContract: string,
    user: string,
    amountRaw: bigint,
  ): Promise<bigint> {
    const data = RESCUE_INTERFACE.encodeFunctionData('previewResultingHF', [
      user,
      WBTC_CONTRACT,
      amountRaw,
    ]);
    const result = await provider.call({ to: rescueContract, data });
    const [hf] = RESCUE_INTERFACE.decodeFunctionResult('previewResultingHF', result);
    return BigInt(hf);
  }

  private async submitRescueTransaction(
    from: string,
    rescueContract: string,
    amountRaw: bigint,
    minResultingHF: bigint,
    deadline: number,
  ): Promise<string> {
    const wallet = this.getWallet();
    if (wallet.address.toLowerCase() !== from.toLowerCase()) {
      throw new Error(
        `Signer address mismatch: private key controls ${wallet.address} but expected ${from}. ` +
          `The configured private key must correspond to the monitored wallet address.`,
      );
    }

    const data = RESCUE_INTERFACE.encodeFunctionData('rescue', [
      {
        user: from,
        asset: WBTC_CONTRACT,
        amount: amountRaw,
        minResultingHF,
        deadline,
      },
    ]);

    const tx = await wallet.sendTransaction({ to: rescueContract, data });
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      throw new Error(`Transaction reverted: ${tx.hash}`);
    }

    return tx.hash;
  }

  private async getTokenBalance(
    provider: JsonRpcProvider,
    token: string,
    owner: string,
  ): Promise<bigint> {
    const data = ERC20_INTERFACE.encodeFunctionData('balanceOf', [owner]);
    const result = await provider.call({ to: token, data });
    const [balance] = ERC20_INTERFACE.decodeFunctionResult('balanceOf', result);
    return BigInt(balance);
  }

  private async getTokenAllowance(
    provider: JsonRpcProvider,
    token: string,
    owner: string,
    spender: string,
  ): Promise<bigint> {
    const data = ERC20_INTERFACE.encodeFunctionData('allowance', [owner, spender]);
    const result = await provider.call({ to: token, data });
    const [allowance] = ERC20_INTERFACE.decodeFunctionResult('allowance', result);
    return BigInt(allowance);
  }

  private async getGasPriceGwei(provider: JsonRpcProvider): Promise<number> {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    return Number(gasPrice) / 1e9;
  }

  private async getEthBalance(provider: JsonRpcProvider, address: string): Promise<number> {
    const balance = await provider.getBalance(address);
    return Number(balance) / 1e18;
  }

  private getProvider(): JsonRpcProvider {
    if (!this.provider) {
      this.provider = new JsonRpcProvider(this.rpcUrl);
    }
    return this.provider;
  }

  private getWallet(): Wallet {
    if (!this.privateKey) {
      throw new Error('No private key configured');
    }
    if (!this.wallet) {
      this.wallet = new Wallet(this.privateKey, this.getProvider());
    }
    return this.wallet;
  }

  private toNumberAmount(value: bigint): number {
    return Number(formatUnits(value, WBTC_DECIMALS));
  }

  private toWad(value: number): bigint {
    // Round to 4 decimal places to avoid floating-point artifacts like 1.849999999999999956
    return parseUnits(value.toFixed(4), 18);
  }

  private wadToNumber(value: bigint): number {
    return Number(formatUnits(value, 18));
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
    logger.info(
      {
        action: entry.action,
        reason: entry.reason,
        loan: entry.loanId,
        healthFactor: Number(entry.healthFactor.toFixed(4)),
        topUpWbtc: entry.topUpWbtc,
        ...(entry.txHash && { txHash: entry.txHash }),
      },
      'Watchdog log entry',
    );
  }
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((min, value) => (value < min ? value : min));
}
