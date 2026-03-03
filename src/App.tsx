import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { formatDistance } from 'date-fns';
import { AlertTriangle, Info, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { Badge, type BadgeVariant } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader } from './components/ui/card';
import { Input } from './components/ui/input';
import { Separator } from './components/ui/separator';
import {
  type BadgeTone,
  type FetchState,
  type LoanPosition,
  ETHEREUM_ADDRESS_REGEX,
  DEFAULT_R_DEPLOY,
  STABLECOIN_SYMBOLS,
  clamp,
  computeLoanMetrics,
  healthLabel,
  portfolioHealthFactorBand,
  parseDeployRate,
  fetchFromAaveSubgraph,
  fetchUsdPrices,
  buildLoanPositions,
} from '@aave-monitor/core';
import { NotificationBell } from './components/NotificationSettings';

const GRAPH_API_KEY = import.meta.env.VITE_THE_GRAPH_API_KEY as string | undefined;
const COINGECKO_API_KEY = import.meta.env.VITE_COINGECKO_API_KEY as string | undefined;
const R_DEPLOY_ENV = import.meta.env.VITE_R_DEPLOY as string | undefined;
const R_DEPLOY = parseDeployRate(R_DEPLOY_ENV, DEFAULT_R_DEPLOY);
const NOTIFICATION_API_URL =
  (import.meta.env.VITE_NOTIFICATION_API_URL as string | undefined) ?? '';
const UPDATE_RATE_MS = 120_000;

async function fetchWalletStablecoins(wallet: string): Promise<Map<string, number>> {
  if (!NOTIFICATION_API_URL) return new Map();
  const res = await fetch(`${NOTIFICATION_API_URL}/api/balances/${wallet}`);
  if (!res.ok) return new Map();
  const data = (await res.json()) as Record<string, number>;
  return new Map(Object.entries(data));
}

function getWalletFromQueryString(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('wallet') ?? params.get('address') ?? params.get('walletAddress') ?? '';
}

function fmtUSD(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function fmtPct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtAmount(value: number, digits = 4): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function fmtTimeAgo(value: string, now: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  if (date.getTime() >= now) return 'just now';
  return formatDistance(date, new Date(now), { addSuffix: true });
}

function toBadgeVariant(tone: BadgeTone): BadgeVariant {
  if (tone === 'positive') return 'positive';
  if (tone === 'warning') return 'warning';
  if (tone === 'danger') return 'destructive';
  return 'default';
}

export default function App() {
  const [wallet, setWallet] = useState(() => getWalletFromQueryString());
  const [selectedLoanId, setSelectedLoanId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [result, setResult] = useState<FetchState | null>(null);
  const [walletStablecoins, setWalletStablecoins] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const hasAutoFetchedFromQuery = useRef(false);

  const selectedLoan = useMemo(() => {
    if (!result || result.loans.length === 0) return null;
    return result.loans.find((loan) => loan.id === selectedLoanId) ?? result.loans[0] ?? null;
  }, [result, selectedLoanId]);

  const computed = useMemo(() => computeLoanMetrics(selectedLoan, R_DEPLOY), [selectedLoan]);
  const status = healthLabel(computed.healthFactor);
  const portfolio = useMemo(() => {
    if (!result || result.loans.length === 0) return null;

    const metrics = result.loans.map((loan: LoanPosition) => computeLoanMetrics(loan, R_DEPLOY));
    const totalDebt = metrics.reduce((sum, item) => sum + item.debt, 0);
    const totalCollateral = metrics.reduce((sum, item) => sum + item.collateralUSD, 0);
    const totalNetWorth = metrics.reduce((sum, item) => sum + item.equity, 0);
    const totalSupplyEarn = metrics.reduce((sum, item) => sum + item.supplyEarnUSD, 0);
    const totalBorrowCost = metrics.reduce((sum, item) => sum + item.borrowCostUSD, 0);
    const totalDeployEarn = metrics.reduce((sum, item) => sum + item.deployEarnUSD, 0);
    const totalNetEarn = metrics.reduce((sum, item) => sum + item.netEarnUSD, 0);
    const totalMaxBorrow = metrics.reduce((sum, item) => sum + item.maxBorrowByLTV, 0);

    const finiteHealthFactors = metrics
      .map((item) => item.healthFactor)
      .filter((item) => Number.isFinite(item));
    const averageHealthFactor =
      finiteHealthFactors.length > 0
        ? finiteHealthFactors.reduce((sum, item) => sum + item, 0) / finiteHealthFactors.length
        : Infinity;

    // Cash margin of safety
    let suppliedStablecoinUsd = 0;
    for (const loan of result.loans) {
      for (const asset of loan.supplied) {
        if (STABLECOIN_SYMBOLS.has(asset.symbol)) {
          suppliedStablecoinUsd += asset.usdValue;
        }
      }
    }
    let walletStablecoinUsd = 0;
    for (const value of walletStablecoins.values()) {
      walletStablecoinUsd += value;
    }
    const totalStablecoinUsd = suppliedStablecoinUsd + walletStablecoinUsd;
    const cashMargin = totalDebt > 0 ? totalStablecoinUsd / totalDebt : 0;

    return {
      loanCount: metrics.length,
      totalDebt,
      totalCollateral,
      totalNetWorth,
      totalSupplyEarn,
      totalBorrowCost,
      totalDeployEarn,
      totalNetEarn,
      averageHealthFactor,
      averageSupplyApy: totalCollateral > 0 ? totalSupplyEarn / totalCollateral : 0,
      averageBorrowApy: totalDebt > 0 ? totalBorrowCost / totalDebt : 0,
      portfolioNetApy: totalNetWorth > 0 ? totalNetEarn / totalNetWorth : 0,
      borrowPowerUsed: totalMaxBorrow > 0 ? totalDebt / totalMaxBorrow : 0,
      cashMargin,
      totalStablecoinUsd,
    };
  }, [result, walletStablecoins]);
  const portfolioHealthBand = useMemo(
    () => portfolioHealthFactorBand(portfolio?.averageHealthFactor ?? NaN),
    [portfolio],
  );

  const fetchLoans = useCallback(async (normalizedWallet: string) => {
    setError('');
    setIsLoading(true);

    try {
      const [reserves, stableBalances] = await Promise.all([
        fetchFromAaveSubgraph(normalizedWallet, GRAPH_API_KEY),
        fetchWalletStablecoins(normalizedWallet).catch(() => new Map<string, number>()),
      ]);
      const reserveSymbols = Array.from(new Set(reserves.map((entry) => entry.reserve.symbol)));
      const prices = await fetchUsdPrices(reserveSymbols, COINGECKO_API_KEY);
      const loans = buildLoanPositions(reserves, prices);
      const updatedAt = Date.now();

      setWalletStablecoins(stableBalances);
      setNow(updatedAt);
      setResult({
        wallet: normalizedWallet,
        loans,
        lastUpdated: new Date(updatedAt).toISOString(),
      });
      setSelectedLoanId((previousLoanId) =>
        loans.some((loan) => loan.id === previousLoanId) ? previousLoanId : (loans[0]?.id ?? ''),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch loan data.';
      setError(message);
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasAutoFetchedFromQuery.current) return;
    const walletFromQuery = getWalletFromQueryString().trim();

    if (!ETHEREUM_ADDRESS_REGEX.test(walletFromQuery)) return;

    hasAutoFetchedFromQuery.current = true;
    void fetchLoans(walletFromQuery);
  }, [fetchLoans]);

  useEffect(() => {
    if (!result?.wallet) return;

    const timerId = window.setInterval(() => {
      if (isLoading) return;
      void fetchLoans(result.wallet);
    }, UPDATE_RATE_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [result?.wallet, isLoading, fetchLoans]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNow(Date.now());
    }, 10_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  const handleFetch = async (event: FormEvent) => {
    event.preventDefault();

    const normalizedWallet = wallet.trim();
    if (!ETHEREUM_ADDRESS_REGEX.test(normalizedWallet)) {
      setError('Please enter a valid Ethereum wallet address.');
      setResult(null);
      return;
    }

    await fetchLoans(normalizedWallet);
  };

  const handleRefresh = async () => {
    const normalizedWallet = result?.wallet ?? wallet.trim();
    if (!ETHEREUM_ADDRESS_REGEX.test(normalizedWallet)) {
      setError('Please enter a valid Ethereum wallet address.');
      setResult(null);
      return;
    }

    await fetchLoans(normalizedWallet);
  };

  return (
    <div className="min-h-screen w-full bg-[radial-gradient(circle_at_0%_0%,#0f3a68_0%,#081019_58%,#04070d_100%)] px-4 py-4 text-[#dce8f6] antialiased md:px-6 md:py-6">
      <main className="mx-auto max-w-[1280px]">
        <header className="flex items-end justify-between gap-4 max-[980px]:flex-col max-[980px]:items-start">
          <div>
            <h1 className="text-[clamp(1.4rem,3vw,2rem)] tracking-[0.01em]">
              Aave Loan Health Dashboard
            </h1>
            <p className="mt-1.5 text-[#9fb1c7]">
              Auto-fetched from wallet address using public blockchain data and price APIs.
            </p>
          </div>
          <NotificationBell />
        </header>

        <section className="mt-4 rounded-[18px] border border-[rgba(168,191,217,0.22)] bg-[linear-gradient(140deg,rgba(11,24,39,0.82),rgba(9,16,28,0.6))] p-4 backdrop-blur-[8px]">
          <form
            className="flex flex-wrap items-end gap-3 max-[980px]:items-stretch"
            onSubmit={handleFetch}
          >
            <label
              className="grid min-w-0 gap-[5px] text-[0.84rem] max-[980px]:w-full max-[980px]:max-w-full"
              htmlFor="wallet"
            >
              <span className="text-[#afc0d5]">Wallet address</span>
              <Input
                className="max-[980px]:max-w-full"
                id="wallet"
                type="text"
                value={wallet}
                onChange={(event) => setWallet(event.target.value)}
                placeholder="0x..."
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            <Button
              className="max-[980px]:w-full max-[980px]:max-w-full"
              type="submit"
              disabled={isLoading}
            >
              {isLoading ? <RefreshCw size={16} className="animate-spin" /> : <Wallet size={16} />}
              {isLoading ? 'Fetching loans...' : 'Fetch loans'}
            </Button>
            <Button
              className="max-[980px]:w-full max-[980px]:max-w-full"
              type="button"
              variant="secondary"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              <RefreshCw size={16} className={isLoading ? 'animate-spin' : undefined} />
              Refresh
            </Button>
          </form>

          {error ? (
            <p className="mt-2 inline-flex items-center gap-2 text-[0.9rem] text-red-200">
              <AlertTriangle size={16} />
              {error}
            </p>
          ) : null}
        </section>

        {result ? (
          <>
            <article className="mt-3 grid gap-[5px] rounded-[18px] border border-[rgba(168,191,217,0.22)] bg-[linear-gradient(140deg,rgba(11,24,39,0.82),rgba(9,16,28,0.6))] px-4 py-[14px] backdrop-blur-[8px]">
              <p className="text-[0.79rem] text-[#9fb1c7]">Wallet</p>
              <p className="break-all text-[0.9rem] font-mono">{result.wallet}</p>
              <p className="text-[0.79rem] text-[#9fb1c7]">
                Found {result.loans.length} active loan position(s)
              </p>
              <p className="text-[0.79rem] text-[#9fb1c7]">
                Last updated: {fmtTimeAgo(result.lastUpdated, now)}
              </p>
            </article>

            {result.loans.length > 0 ? (
              <>
                {portfolio ? (
                  <Card className="mt-4">
                    <CardHeader>
                      <h2 className="inline-flex items-center gap-2 text-base">
                        Portfolio Metrics <Info size={16} />
                      </h2>
                    </CardHeader>
                    <CardContent className="grid-cols-3 max-[980px]:grid-cols-1">
                      <KpiCard
                        title="Active loans"
                        value={String(portfolio.loanCount)}
                        caption="Detected borrowed positions"
                      />
                      <KpiCard
                        title="Total debt"
                        value={fmtUSD(portfolio.totalDebt, 0)}
                        caption="Combined across all active loans"
                      />
                      <KpiCard
                        title="Total net worth"
                        value={fmtUSD(portfolio.totalNetWorth, 0)}
                        caption="Collateral − Debt"
                      />
                      <KpiCard
                        title="Average health factor"
                        value={
                          Number.isFinite(portfolio.averageHealthFactor)
                            ? portfolio.averageHealthFactor.toFixed(2)
                            : '∞'
                        }
                        valueClassName={portfolioHealthBand.valueClassName}
                        caption={`Arithmetic average across active loans · ${portfolioHealthBand.guidance}`}
                      />
                      <KpiCard
                        title="Net APY (portfolio)"
                        value={fmtPct(portfolio.portfolioNetApy)}
                        valueClassName={
                          portfolio.portfolioNetApy >= 0
                            ? 'text-green-400'
                            : portfolio.portfolioNetApy > -0.03
                              ? 'text-yellow-400'
                              : 'text-red-400'
                        }
                        caption="Weighted by net worth"
                      />
                      <KpiCard
                        title="Borrow power used"
                        value={fmtPct(portfolio.borrowPowerUsed)}
                        caption="Debt / Max borrow by LTV"
                      />
                      <KpiCard
                        title="Cash margin of safety"
                        value={fmtPct(portfolio.cashMargin)}
                        valueClassName={
                          portfolio.cashMargin >= 0.1
                            ? 'text-green-400'
                            : portfolio.cashMargin >= 0.05
                              ? 'text-yellow-400'
                              : 'text-red-400'
                        }
                        caption={`${fmtUSD(portfolio.totalStablecoinUsd, 0)} stablecoins / ${fmtUSD(portfolio.totalDebt, 0)} debt`}
                      />
                    </CardContent>
                    <CardContent>
                      <Row label="Total collateral" value={fmtUSD(portfolio.totalCollateral, 0)} />
                      <Row
                        label="Supply APY (weighted)"
                        value={fmtPct(portfolio.averageSupplyApy)}
                      />
                      <Row
                        label="Borrow APY (weighted)"
                        value={fmtPct(portfolio.averageBorrowApy)}
                      />
                      <Row
                        label="Net earnings (annual)"
                        value={fmtUSD(portfolio.totalNetEarn, 0)}
                      />
                      <Row
                        label="Debt deploy earnings est. (yearly)"
                        value={fmtUSD(portfolio.totalDeployEarn, 0)}
                      />
                    </CardContent>
                  </Card>
                ) : null}

                <nav className="mt-3 flex flex-wrap gap-2" aria-label="Loan positions">
                  {result.loans.map((loan, index) => (
                    <Button
                      key={loan.id}
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={`${
                        loan.id === selectedLoan?.id
                          ? 'border-[rgba(200,222,247,0.6)] bg-[linear-gradient(135deg,#355f9e,#24436f)]'
                          : ''
                      }`}
                      onClick={() => setSelectedLoanId(loan.id)}
                    >
                      Loan {index + 1}: {loan.marketName} · {loan.borrowed.symbol}
                    </Button>
                  ))}
                </nav>

                <section className="mt-4 grid gap-4 [grid-template-columns:minmax(320px,0.95fr)_minmax(0,2fr)] max-[980px]:grid-cols-1">
                  <Card>
                    <CardHeader>
                      <h2 className="inline-flex items-center gap-2 text-base">
                        Position Snapshot <Info size={16} />
                      </h2>
                    </CardHeader>
                    <CardContent>
                      <StaticField
                        label="Borrowed asset"
                        value={`${fmtAmount(selectedLoan?.borrowed.amount ?? 0)} ${selectedLoan?.borrowed.symbol ?? ''}`}
                      />
                      <StaticField label="Market" value={selectedLoan?.marketName ?? '—'} />
                      <StaticField label="Debt (USD)" value={fmtUSD(computed.debt, 0)} />
                      <Separator />

                      <div className="grid min-w-0 gap-[5px] text-[0.84rem]">
                        <span className="text-[#afc0d5]">Supplied collateral assets</span>
                        <ul className="grid list-none gap-1.5">
                          {selectedLoan?.supplied.map((asset) => (
                            <li
                              key={`${asset.address}-${asset.symbol}`}
                              className="flex justify-between gap-[10px] rounded-[10px] border border-[rgba(168,191,217,0.2)] bg-[rgba(12,24,38,0.6)] px-[10px] py-2 max-[980px]:flex-col max-[980px]:items-start"
                            >
                              <span>{asset.symbol}</span>
                              <span>
                                {fmtAmount(asset.amount)} | {fmtUSD(asset.usdValue, 0)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <StaticField
                        label="Collateral value (USD)"
                        value={fmtUSD(computed.collateralUSD, 0)}
                      />
                      <Separator />

                      <TwoColumn>
                        <StaticField label="Max LTV (weighted)" value={fmtPct(computed.ltvMax)} />
                        <StaticField
                          label="Liquidation threshold (weighted)"
                          value={fmtPct(computed.lt)}
                        />
                      </TwoColumn>

                      <Separator />

                      <TwoColumn>
                        <StaticField
                          label="Supply APY (weighted)"
                          value={fmtPct(computed.rSupply)}
                        />
                        <StaticField label="Borrow APY" value={fmtPct(computed.rBorrow)} />
                      </TwoColumn>

                      <StaticField
                        label="Borrowed funds deploy APY"
                        value={fmtPct(computed.rDeploy)}
                        hint="Set from your strategy outside this dashboard."
                      />
                    </CardContent>
                  </Card>

                  <div className="grid gap-4">
                    <Card>
                      <CardHeader>
                        <h2 className="inline-flex items-center gap-2 text-base">
                          Status
                          <Badge variant={toBadgeVariant(status.tone)}>{status.label}</Badge>
                          {computed.healthFactor < 1.5 ? (
                            <AlertTriangle size={16} />
                          ) : (
                            <ShieldCheck size={16} />
                          )}
                        </h2>
                      </CardHeader>
                      <CardContent className="grid-cols-3 max-[980px]:grid-cols-1">
                        <KpiCard
                          title="Health Factor (HF)"
                          value={
                            Number.isFinite(computed.healthFactor)
                              ? computed.healthFactor.toFixed(2)
                              : '∞'
                          }
                          caption="Liquidation when HF < 1.0"
                        />
                        <KpiCard
                          title={`Liquidation Price (${computed.primaryCollateralSymbol})`}
                          value={
                            Number.isFinite(computed.liqPrice) ? fmtUSD(computed.liqPrice, 2) : '—'
                          }
                          caption={`Price drop to liq: ${fmtPct(clamp(computed.priceDropToLiq, 0, 1), 1)}`}
                        />
                        <KpiCard
                          title="Equity"
                          value={fmtUSD(computed.equity, 0)}
                          caption="Collateral − Debt"
                        />
                      </CardContent>
                    </Card>

                    <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
                      <Card>
                        <CardHeader>
                          <h2 className="inline-flex items-center gap-2 text-base">Main Metrics</h2>
                        </CardHeader>
                        <CardContent>
                          <Row label="Collateral value" value={fmtUSD(computed.collateralUSD, 0)} />
                          <Row label="Debt" value={fmtUSD(computed.debt, 0)} />
                          <Row label="LTV" value={fmtPct(computed.ltv)} />
                          <Row
                            label="Leverage (C/E)"
                            value={
                              Number.isFinite(computed.leverage)
                                ? `${computed.leverage.toFixed(2)}x`
                                : '∞'
                            }
                          />
                          <Row label="Borrow power used" value={fmtPct(computed.borrowPowerUsed)} />
                          <Row label="Borrow headroom" value={fmtUSD(computed.borrowHeadroom, 0)} />
                          <Separator />
                          <Row label="Liquidation threshold" value={fmtPct(computed.lt)} />
                          <Row label="LTV at liquidation" value={fmtPct(computed.ltvAtLiq)} />
                          <Row
                            label="Collateral buffer"
                            value={fmtUSD(computed.collateralBufferUSD, 0)}
                          />
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <h2 className="inline-flex items-center gap-2 text-base">
                            Carry / Net APY
                          </h2>
                        </CardHeader>
                        <CardContent>
                          <Row label="Supply APY" value={fmtPct(computed.rSupply)} />
                          <Row label="Borrow APY" value={fmtPct(computed.rBorrow)} />
                          <Row label="Deploy APY (optional)" value={fmtPct(computed.rDeploy)} />
                          <Separator />
                          <Row
                            label="Supply earnings (annual)"
                            value={fmtUSD(computed.supplyEarnUSD, 0)}
                          />
                          <Row
                            label="Borrow cost (annual)"
                            value={fmtUSD(computed.borrowCostUSD, 0)}
                          />
                          <Row
                            label="Deploy earnings (annual)"
                            value={fmtUSD(computed.deployEarnUSD, 0)}
                          />
                          <Separator />
                          <Row
                            label="Net earnings (annual)"
                            value={fmtUSD(computed.netEarnUSD, 0)}
                          />
                          <Row
                            label="Debt deploy earnings est. (yearly)"
                            value={fmtUSD(computed.deployEarnUSD, 0)}
                          />
                          <Row
                            label="Net APY (on equity)"
                            value={fmtPct(computed.netAPYOnEquity)}
                          />
                          <p className="text-[0.79rem] text-[#9fb1c7]">
                            Net APY is ROE: (supply − borrow) / equity.
                          </p>
                          <p className="text-[0.79rem] text-[#9fb1c7]">
                            Debt deploy estimate assumes 100% of debt earns deploy APY.
                          </p>
                        </CardContent>
                      </Card>
                    </div>

                    <Card>
                      <CardHeader>
                        <h2 className="inline-flex items-center gap-2 text-base">
                          Monitoring Checklist
                        </h2>
                      </CardHeader>
                      <CardContent className="grid-cols-3 max-[980px]:grid-cols-1">
                        <ChecklistItem
                          title="Health Factor"
                          ok={!computed.alertHF}
                          detail="Keep HF comfortably above 1.0; many traders target 1.7-2.5+."
                        />
                        <ChecklistItem
                          title="LTV vs LT"
                          ok={!computed.alertLTV}
                          detail="As LTV approaches liquidation threshold, small price moves can liquidate you."
                        />
                        <ChecklistItem
                          title="Rates drift"
                          ok
                          detail="Borrow/supply APYs are variable; net carry can flip quickly during volatility."
                        />
                        <ChecklistItem
                          title="Stablecoin depeg"
                          ok
                          detail="USDC/USDT are usually close to $1, but depegs can distort debt value."
                        />
                        <ChecklistItem
                          title="Oracle / market"
                          ok
                          detail="Liquidations depend on oracle price; liquidity + slippage matters in crashes."
                        />
                        <ChecklistItem
                          title="Automation"
                          ok
                          detail="Consider alerts (HF, price, LTV) and an emergency delever playbook."
                        />
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <h2 className="inline-flex items-center gap-2 text-base">Sensitivity</h2>
                      </CardHeader>
                      <CardContent className="grid-cols-3 max-[980px]:grid-cols-1">
                        <KpiCard
                          title="Equity move for ±10% price"
                          value={
                            Number.isFinite(computed.leverage)
                              ? fmtPct(computed.equityMoveFor10Pct, 1)
                              : '—'
                          }
                          caption="Approx = leverage × 10%"
                        />
                        <KpiCard
                          title="Max borrow (by LTV)"
                          value={fmtUSD(computed.maxBorrowByLTV, 0)}
                          caption="Based on weighted collateral LTV"
                        />
                        <KpiCard
                          title="Collateral needed at HF=1"
                          value={fmtUSD(computed.collateralUSDAtLiq, 0)}
                          caption="= Debt / liquidation threshold"
                        />
                      </CardContent>
                    </Card>
                  </div>
                </section>
              </>
            ) : (
              <article className="mt-3 rounded-[18px] border border-[rgba(168,191,217,0.22)] bg-[linear-gradient(140deg,rgba(11,24,39,0.82),rgba(9,16,28,0.6))] p-4 backdrop-blur-[8px]">
                <p>No borrowed positions were found for this wallet on Aave V3 Ethereum.</p>
              </article>
            )}
          </>
        ) : null}

        <footer className="mt-[18px] text-[0.79rem] text-[#9fb1c7]">
          <p>
            Simplified monitor. Multi-collateral liquidation price is shown for the primary
            collateral asset only.
          </p>
        </footer>
      </main>
    </div>
  );
}

function TwoColumn({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function StaticField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid min-w-0 gap-[5px] text-[0.84rem]">
      <span className="text-[#afc0d5]">{label}</span>
      <p className="text-[0.95rem] font-semibold text-[#e8f2ff]">{value}</p>
      {hint ? <p className="text-[0.79rem] text-[#9fb1c7]">{hint}</p> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-[0.92rem]">
      <span className="text-[#9fb1c7]">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function ChecklistItem({ title, detail, ok }: { title: string; detail: string; ok: boolean }) {
  return (
    <article className="rounded-[14px] border border-[rgba(168,191,217,0.18)] bg-[rgba(14,25,39,0.6)] p-3">
      <div className="flex items-center justify-between gap-[10px]">
        <h3 className="text-[0.94rem]">{title}</h3>
        <Badge variant={ok ? 'positive' : 'destructive'}>{ok ? 'OK' : 'Watch'}</Badge>
      </div>
      <p className="text-[0.79rem] text-[#9fb1c7]">{detail}</p>
    </article>
  );
}

function KpiCard({
  title,
  value,
  caption,
  valueClassName,
}: {
  title: string;
  value: string;
  caption: string;
  valueClassName?: string;
}) {
  return (
    <article className="rounded-[14px] border border-[rgba(168,191,217,0.18)] bg-[rgba(14,25,39,0.6)] p-3">
      <p className="text-[0.79rem] text-[#9fb1c7]">{title}</p>
      <p className={`my-1 text-[1.7rem] font-semibold ${valueClassName ?? ''}`}>{value}</p>
      <p className="text-[0.79rem] text-[#9fb1c7]">{caption}</p>
    </article>
  );
}
