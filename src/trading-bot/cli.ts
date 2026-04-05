#!/usr/bin/env node
/**
 * CLI Entry Point for the AI Trading Bot
 *
 * Usage:
 *   npx ts-node src/trading-bot/cli.ts [options]
 *
 * Options:
 *   --dry-run        Run in paper trading mode (default: true)
 *   --live           Run in live trading mode (overrides --dry-run)
 *   --budget <n>     Total budget in USDC (default: 10000)
 *   --min-edge <n>   Minimum edge % required (default: 2.0)
 *   --kelly <n>      Kelly fraction (default: 0.25)
 *   --interval <n>   Scan interval in seconds (default: 30)
 *   --debug          Enable debug logging
 */

import { TradingBot } from './bot.js';
import { loadConfigFromEnv, DEFAULT_TRADING_CONFIG } from './config.js';
import type { BotConfig, TradingConfig } from './types.js';

function parseArgs(): Partial<BotConfig> & { tradingOverrides: Partial<TradingConfig> } {
  const args = process.argv.slice(2);
  const tradingOverrides: Partial<TradingConfig> = {};
  let logLevel: BotConfig['logLevel'] = 'info';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];

    switch (arg) {
      case '--dry-run':
        tradingOverrides.dryRun = true;
        break;
      case '--live':
        tradingOverrides.dryRun = false;
        break;
      case '--budget':
        tradingOverrides.totalBudget = Number(next);
        i++;
        break;
      case '--min-edge':
        tradingOverrides.minEdgePercent = Number(next);
        i++;
        break;
      case '--kelly':
        tradingOverrides.kellyFraction = Number(next);
        i++;
        break;
      case '--interval':
        tradingOverrides.scanIntervalMs = Number(next) * 1000;
        i++;
        break;
      case '--max-positions':
        tradingOverrides.maxConcurrentPositions = Number(next);
        i++;
        break;
      case '--max-position-size':
        tradingOverrides.maxPositionSize = Number(next);
        i++;
        break;
      case '--debug':
        logLevel = 'debug';
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return { logLevel, tradingOverrides };
}

function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         AI Trading Bot - Polymarket Arbitrage            ║
║         Powered by Claude AI + Kelly Criterion           ║
╚══════════════════════════════════════════════════════════╝

USAGE:
  npx ts-node src/trading-bot/cli.ts [OPTIONS]

OPTIONS:
  --dry-run              Paper trading mode (default)
  --live                 Live trading with real USDC
  --budget <amount>      Total budget in USDC (default: 10000)
  --min-edge <percent>   Minimum edge % to trade (default: 2.0)
  --kelly <fraction>     Kelly fraction 0-1 (default: 0.25)
  --interval <seconds>   Scan interval (default: 30)
  --max-positions <n>    Max concurrent positions (default: 20)
  --max-position-size <n> Max single position USDC (default: 500)
  --debug                Enable debug logging
  --help                 Show this help

ENVIRONMENT VARIABLES (required):
  POLYMARKET_API_KEY         Polymarket CLOB API key
  POLYMARKET_API_SECRET      Polymarket CLOB API secret
  POLYMARKET_API_PASSPHRASE  Polymarket CLOB API passphrase
  POLYMARKET_PRIVATE_KEY     Polygon wallet private key
  ODDS_API_KEY               The Odds API key
  ANTHROPIC_API_KEY          Anthropic Claude API key

OPTIONAL:
  CLAUDE_MODEL               Claude model (default: claude-sonnet-4-6)
  LOG_LEVEL                  debug|info|warn|error (default: info)
  DRY_RUN                    true|false (default: true)

STRATEGY:
  The bot uses a multi-strategy approach inspired by sovereign2013's
  $1 -> $3.3M Polymarket bot:

  1. Cross-platform arbitrage
     Compare Polymarket prices with sportsbook odds from 10+ bookmakers.
     When Polymarket misprices vs the consensus, trade the difference.

  2. AI mispricing detection
     Claude analyzes each market, estimates fair probability, and
     identifies value where the market disagrees with Claude's analysis.

  3. Multi-outcome arbitrage
     Detect when sum of outcome prices < 1.0 for guaranteed profit.

  4. Kelly criterion position sizing
     Fractional Kelly (default 1/4) for optimal bankroll growth
     with conservative risk management.

EXAMPLES:
  # Paper trade with default settings
  npx ts-node src/trading-bot/cli.ts

  # Paper trade with aggressive settings
  npx ts-node src/trading-bot/cli.ts --budget 50000 --min-edge 1.5 --kelly 0.5

  # Live trade (use with caution!)
  npx ts-node src/trading-bot/cli.ts --live --budget 1000 --min-edge 3.0
`);
}

function printBanner(): void {
  console.log(`
  ┌─────────────────────────────────────────────┐
  │   🤖 AI Trading Bot v1.0                    │
  │   Polymarket Prediction Market Arbitrage     │
  │   Powered by Claude AI                       │
  │                                              │
  │   Strategy: Cross-platform arb + AI analysis │
  │   Sizing: Fractional Kelly Criterion         │
  └─────────────────────────────────────────────┘
  `);
}

async function main(): Promise<void> {
  printBanner();

  const { tradingOverrides, ...configOverrides } = parseArgs();

  const config: BotConfig = (() => {
    try {
      return loadConfigFromEnv({
        ...configOverrides,
        trading: {
          ...DEFAULT_TRADING_CONFIG,
          ...tradingOverrides,
        },
      });
    } catch (err) {
      console.error(`\nConfiguration error: ${(err as Error).message}`);
      console.error('Run with --help for required environment variables.\n');
      process.exit(1);
    }
  })();

  if (!config.trading.dryRun) {
    console.log('\n⚠️  LIVE TRADING MODE ENABLED');
    console.log(`   Budget: $${config.trading.totalBudget}`);
    console.log(`   Max position: $${config.trading.maxPositionSize}`);
    console.log('   Starting in 5 seconds... Press Ctrl+C to cancel.\n');
    await new Promise((r) => setTimeout(r, 5000));
  }

  const bot = new TradingBot(config);

  // Log events
  bot.on((event) => {
    switch (event.type) {
      case 'opportunity_found':
        break; // Already logged by bot
      case 'trade_placed':
        console.log(
          `  >> Trade: ${event.trade.outcome} on "${event.trade.question.slice(0, 50)}" ` +
          `| ${event.trade.size} shares @ $${event.trade.price.toFixed(3)} = $${event.trade.cost.toFixed(2)}`
        );
        break;
      case 'trade_resolved':
        console.log(
          `  << Resolved: "${event.trade.question.slice(0, 40)}" ` +
          `| ${event.trade.status} | PnL: $${event.pnl.toFixed(2)}`
        );
        break;
      case 'risk_alert':
        console.log(`  !! Risk Alert: ${event.message}`);
        break;
      case 'error':
        console.error(`  !! Error [${event.context}]: ${event.error.message}`);
        break;
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
