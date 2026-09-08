const WebSocket = require("ws");

// ============================================================
// CRYPTO ARBITRAGE PAPER ENGINE v4
// Coinbase <-> OKX
// ============================================================

const CONFIG = {
  // ==========================================================
  // COPPIE
  // ==========================================================

  pairs: {
    BTC: {
      coinbase: "BTC-USD",
      okx: "BTC-USDT"
    },

    ETH: {
      coinbase: "ETH-USD",
      okx: "ETH-USDT"
    }
  },

  // ==========================================================
  // PAPER TRADING
  // ==========================================================

  initialCapital: 1000,

  // Percentuale del capitale usata per ogni operazione
  tradePercentOfCapital: 20,

  // Profitto NETTO minimo richiesto
  minNetProfitPercent: 0.10,

  // Conferme consecutive
  requiredConfirmations: 3,

  // ==========================================================
  // COSTI
  // ==========================================================

  coinbaseFeePercent: 0.60,
  okxFeePercent: 0.10,

  coinbaseSlippagePercent: 0.05,
  okxSlippagePercent: 0.05,

  // ==========================================================
  // CONVERSIONE
  // ==========================================================

  usdToUsdt: 1.0,

  // ==========================================================
  // TIMING
  // ==========================================================

  opportunityCooldown: 10000,
  reconnectDelay: 5000,
  statusInterval: 30000
};

// ============================================================
// PAPER PORTFOLIO
// ============================================================

const paper = {
  initialCapital: CONFIG.initialCapital,
  capital: CONFIG.initialCapital,

  totalProfit: 0,

  trades: 0,
  winningTrades: 0,
  losingTrades: 0,

  volume: 0,

  lastTradeTime: {
    BTC: 0,
    ETH: 0
  }
};

// ============================================================
// MARKET BOOK
// ============================================================

const books = {
  BTC: {
    coinbase: {
      bid: null,
      ask: null,
      timestamp: 0
    },

    okx: {
      bid: null,
      ask: null,
      timestamp: 0
    }
  },

  ETH: {
    coinbase: {
      bid: null,
      ask: null,
      timestamp: 0
    },

    okx: {
      bid: null,
      ask: null,
      timestamp: 0
    }
  }
};

// ============================================================
// CONFERME
// ============================================================

const confirmations = {
  BTC: {
    cbToOkx: 0,
    okxToCb: 0
  },

  ETH: {
    cbToOkx: 0,
    okxToCb: 0
  }
};

// ============================================================
// STATISTICHE
// ============================================================

const stats = {
  coinbaseMessages: 0,
  coinbaseUpdates: 0,

  okxMessages: 0,
  okxUpdates: 0,

  checks: 0,
  profitableOpportunities: 0,

  lastOpportunity: null
};

// ============================================================
// UTILITY
// ============================================================

function now() {
  return new Date().toLocaleTimeString("it-IT");
}

function log(message) {
  console.log(`[${now()}] ${message}`);
}

function money(value) {
  return `€${Number(value).toFixed(2)}`;
}

function pct(value) {
  return `${Number(value).toFixed(4)}%`;
}

function validNumber(value) {
  return Number.isFinite(value) && value > 0;
}

// ============================================================
// LOOKUP
// ============================================================

function getPairByCoinbaseProduct(productId) {
  for (const [symbol, pair] of Object.entries(CONFIG.pairs)) {
    if (pair.coinbase === productId) {
      return symbol;
    }
  }

  return null;
}

function getPairByOKXProduct(instId) {
  for (const [symbol, pair] of Object.entries(CONFIG.pairs)) {
    if (pair.okx === instId) {
      return symbol;
    }
  }

  return null;
}

// ============================================================
// COINBASE UPDATE
// ============================================================

function updateCoinbase(data) {
  if (!data || !Array.isArray(data.events)) {
    return;
  }

  for (const event of data.events) {
    if (!event || !Array.isArray(event.tickers)) {
      continue;
    }

    for (const ticker of event.tickers) {
      if (!ticker) {
        continue;
      }

      const symbol =
        getPairByCoinbaseProduct(ticker.product_id);

      if (!symbol) {
        continue;
      }

      const bid = Number(ticker.best_bid);
      const ask = Number(ticker.best_ask);

      let changed = false;

      if (validNumber(bid)) {
        books[symbol].coinbase.bid = bid;
        changed = true;
      }

      if (validNumber(ask)) {
        books[symbol].coinbase.ask = ask;
        changed = true;
      }

      if (changed) {
        books[symbol].coinbase.timestamp = Date.now();

        stats.coinbaseUpdates++;

        checkArbitrage(symbol);
      }
    }
  }
}

// ============================================================
// COINBASE CONNECTION
// ============================================================

function connectCoinbase() {
  const ws = new WebSocket(
    "wss://advanced-trade-ws.coinbase.com"
  );

  ws.on("open", () => {
    log("🟢 Coinbase WebSocket CONNECTED");

    ws.send(
      JSON.stringify({
        type: "subscribe",

        product_ids: [
          CONFIG.pairs.BTC.coinbase,
          CONFIG.pairs.ETH.coinbase
        ],

        channel: "ticker"
      })
    );

    ws.send(
      JSON.stringify({
        type: "subscribe",
        channel: "heartbeats"
      })
    );

    log("🟢 Coinbase subscriptions ATTIVE");
  });

  ws.on("message", raw => {
    try {
      stats.coinbaseMessages++;

      const data = JSON.parse(raw.toString());

      updateCoinbase(data);
    } catch (error) {
      log(
        `❌ Errore Coinbase: ${error.message}`
      );
    }
  });

  ws.on("close", () => {
    log(
      "🔴 Coinbase disconnesso. Riconnessione..."
    );

    setTimeout(
      connectCoinbase,
      CONFIG.reconnectDelay
    );
  });

  ws.on("error", error => {
    log(
      `❌ Coinbase WebSocket error: ${error.message}`
    );
  });
}

// ============================================================
// OKX UPDATE
// ============================================================

function updateOKX(data) {
  if (!data || !data.arg) {
    return;
  }

  if (data.arg.channel !== "books5") {
    return;
  }

  const symbol =
    getPairByOKXProduct(data.arg.instId);

  if (!symbol) {
    return;
  }

  const book = data.data?.[0];

  if (!book) {
    return;
  }

  let changed = false;

  if (
    Array.isArray(book.bids) &&
    book.bids.length > 0
  ) {
    const bid = Number(book.bids[0][0]);

    if (validNumber(bid)) {
      books[symbol].okx.bid = bid;
      changed = true;
    }
  }

  if (
    Array.isArray(book.asks) &&
    book.asks.length > 0
  ) {
    const ask = Number(book.asks[0][0]);

    if (validNumber(ask)) {
      books[symbol].okx.ask = ask;
      changed = true;
    }
  }

  if (changed) {
    books[symbol].okx.timestamp = Date.now();

    stats.okxUpdates++;

    checkArbitrage(symbol);
  }
}

// ============================================================
// OKX CONNECTION
// ============================================================

function connectOKX() {
  const ws = new WebSocket(
    "wss://ws.okx.com:8443/ws/v5/public"
  );

  ws.on("open", () => {
    log("🟢 OKX WebSocket CONNECTED");

    ws.send(
      JSON.stringify({
        op: "subscribe",

        args: [
          {
            channel: "books5",
            instId: CONFIG.pairs.BTC.okx
          },

          {
            channel: "books5",
            instId: CONFIG.pairs.ETH.okx
          }
        ]
      })
    );

    log("🟢 OKX subscriptions ATTIVE");
  });

  ws.on("message", raw => {
    try {
      stats.okxMessages++;

      const text = raw.toString();

      if (text === "ping") {
        ws.send("pong");
        return;
      }

      const data = JSON.parse(text);

      if (data.event === "subscribe") {
        return;
      }

      if (data.event === "error") {
        log(
          `❌ OKX error ${data.code}: ${data.msg}`
        );

        return;
      }

      updateOKX(data);

    } catch (error) {
      log(
        `❌ Errore OKX: ${error.message}`
      );
    }
  });

  ws.on("close", () => {
    log(
      "🔴 OKX disconnesso. Riconnessione..."
    );

    setTimeout(
      connectOKX,
      CONFIG.reconnectDelay
    );
  });

  ws.on("error", error => {
    log(
      `❌ OKX WebSocket error: ${error.message}`
    );
  });
}

// ============================================================
// ARBITRAGGIO
// ============================================================

function checkArbitrage(symbol) {
  const cb = books[symbol].coinbase;
  const okx = books[symbol].okx;

  if (
    !validNumber(cb.bid) ||
    !validNumber(cb.ask) ||
    !validNumber(okx.bid) ||
    !validNumber(okx.ask)
  ) {
    return;
  }

  stats.checks++;

  // ==========================================================
  // CONVERSIONE USD / USDT
  // ==========================================================

  const okxBidUSD =
    okx.bid / CONFIG.usdToUsdt;

  const okxAskUSD =
    okx.ask / CONFIG.usdToUsdt;

  // ==========================================================
  // DIREZIONE 1
  //
  // COMPRA COINBASE
  // VENDE OKX
  // ==========================================================

  const grossCBtoOKX =
    (
      (okxBidUSD - cb.ask) /
      cb.ask
    ) * 100;

  const effectiveCBBuy =
    cb.ask *
    (
      1 +
      CONFIG.coinbaseSlippagePercent / 100
    );

  const effectiveOKXSell =
    okxBidUSD *
    (
      1 -
      CONFIG.okxSlippagePercent / 100
    );

  const cbCost =
    effectiveCBBuy *
    (
      1 +
      CONFIG.coinbaseFeePercent / 100
    );

  const okxRevenue =
    effectiveOKXSell *
    (
      1 -
      CONFIG.okxFeePercent / 100
    );

  const netCBtoOKX =
    (
      (okxRevenue - cbCost) /
      cbCost
    ) * 100;

  // ==========================================================
  // DIREZIONE 2
  //
  // COMPRA OKX
  // VENDE COINBASE
  // ==========================================================

  const grossOKXtoCB =
    (
      (cb.bid - okxAskUSD) /
      okxAskUSD
    ) * 100;

  const effectiveOKXBuy =
    okxAskUSD *
    (
      1 +
      CONFIG.okxSlippagePercent / 100
    );

  const effectiveCBSell =
    cb.bid *
    (
      1 -
      CONFIG.coinbaseSlippagePercent / 100
    );

  const okxCost =
    effectiveOKXBuy *
    (
      1 +
      CONFIG.okxFeePercent / 100
    );

  const cbRevenue =
    effectiveCBSell *
    (
      1 -
      CONFIG.coinbaseFeePercent / 100
    );

  const netOKXtoCB =
    (
      (cbRevenue - okxCost) /
      okxCost
    ) * 100;

  // ==========================================================
  // BREAK EVEN REALE
  // ==========================================================

  const breakEvenCBtoOKX =
    (
      (
        (1 + CONFIG.coinbaseFeePercent / 100) *
        (1 + CONFIG.coinbaseSlippagePercent / 100)
      ) /
      (
        (1 - CONFIG.okxFeePercent / 100) *
        (1 - CONFIG.okxSlippagePercent / 100)
      )
      - 1
    ) * 100;

  const breakEvenOKXtoCB =
    (
      (
        (1 + CONFIG.okxFeePercent / 100) *
        (1 + CONFIG.okxSlippagePercent / 100)
      ) /
      (
        (1 - CONFIG.coinbaseFeePercent / 100) *
        (1 - CONFIG.coinbaseSlippagePercent / 100)
      )
      - 1
    ) * 100;

  // ==========================================================
  // CONFERME
  // ==========================================================

  if (
    netCBtoOKX >=
    CONFIG.minNetProfitPercent
  ) {
    confirmations[symbol].cbToOkx++;
  } else {
    confirmations[symbol].cbToOkx = 0;
  }

  if (
    netOKXtoCB >=
    CONFIG.minNetProfitPercent
  ) {
    confirmations[symbol].okxToCb++;
  } else {
    confirmations[symbol].okxToCb = 0;
  }

  // ==========================================================
  // DISPLAY
  // ==========================================================

  displayStatus(
    symbol,
    cb,
    okx,
    grossCBtoOKX,
    netCBtoOKX,
    grossOKXtoCB,
    netOKXtoCB,
    breakEvenCBtoOKX,
    breakEvenOKXtoCB
  );

  // ==========================================================
  // PAPER TRADE CB -> OKX
  // ==========================================================

  if (
    confirmations[symbol].cbToOkx >=
    CONFIG.requiredConfirmations
  ) {

    executePaperTrade(
      symbol,
      "Coinbase",
      cb.ask,
      "OKX",
      okxBidUSD,
      grossCBtoOKX,
      netCBtoOKX
    );

    confirmations[symbol].cbToOkx = 0;
  }

  // ==========================================================
  // PAPER TRADE OKX -> CB
  // ==========================================================

  if (
    confirmations[symbol].okxToCb >=
    CONFIG.requiredConfirmations
  ) {

    executePaperTrade(
      symbol,
      "OKX",
      okxAskUSD,
      "Coinbase",
      cb.bid,
      grossOKXtoCB,
      netOKXtoCB
    );

    confirmations[symbol].okxToCb = 0;
  }
}

// ============================================================
// DISPLAY STATUS
// ============================================================

function displayStatus(
  symbol,
  cb,
  okx,
  gross1,
  net1,
  gross2,
  net2,
  breakEven1,
  breakEven2
) {

  console.log("");

  console.log(
    "--------------------------------------------------------"
  );

  console.log(
    `📊 ${symbol}`
  );

  console.log(
    `Coinbase -> BID: ${cb.bid.toFixed(2)} | ASK: ${cb.ask.toFixed(2)}`
  );

  console.log(
    `OKX      -> BID: ${okx.bid.toFixed(2)} | ASK: ${okx.ask.toFixed(2)}`
  );

  console.log("");

  console.log(
    `CB -> OKX | Lordo: ${pct(gross1)} | Netto: ${pct(net1)}`
  );

  console.log(
    `OKX -> CB | Lordo: ${pct(gross2)} | Netto: ${pct(net2)}`
  );

  console.log("");

  console.log(
    `Break-even CB -> OKX: ${pct(breakEven1)}`
  );

  console.log(
    `Break-even OKX -> CB: ${pct(breakEven2)}`
  );

  console.log("");

  console.log(
    `Conferma CB -> OKX: ${confirmations[symbol].cbToOkx}/${CONFIG.requiredConfirmations}`
  );

  console.log(
    `Conferma OKX -> CB: ${confirmations[symbol].okxToCb}/${CONFIG.requiredConfirmations}`
  );

  console.log("");

  console.log(
    `💰 Capitale PAPER: ${money(paper.capital)}`
  );

  console.log(
    `💵 Profitto totale: ${money(paper.totalProfit)}`
  );

  console.log(
    `📈 Operazioni: ${paper.trades}`
  );

  if (
    net1 >= CONFIG.minNetProfitPercent ||
    net2 >= CONFIG.minNetProfitPercent
  ) {
    console.log(
      "🟢 POSSIBILE OPPORTUNITÀ PROFITTEVOLE"
    );
  } else {
    console.log(
      "⚪ Nessuna opportunità profittevole"
    );
  }

  console.log(
    "--------------------------------------------------------"
  );
}

// ============================================================
// PAPER TRADE
// ============================================================

function executePaperTrade(
  symbol,
  buyExchange,
  buyPrice,
  sellExchange,
  sellPrice,
  grossPercent,
  netPercent
) {

  const currentTime = Date.now();

  // ==========================================================
  // COOLDOWN
  // ==========================================================

  if (
    currentTime -
    paper.lastTradeTime[symbol] <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  // ==========================================================
  // CONTROLLO NETTO
  // ==========================================================

  if (
    netPercent <
    CONFIG.minNetProfitPercent
  ) {
    return;
  }

  // ==========================================================
  // CAPITALE
  // ==========================================================

  const tradeAmount =
    paper.capital *
    (
      CONFIG.tradePercentOfCapital /
      100
    );

  if (
    tradeAmount <= 0 ||
    paper.capital < tradeAmount
  ) {
    log(
      "⚠️ Capitale PAPER insufficiente"
    );

    return;
  }

  // ==========================================================
  // PROFITTO
  // ==========================================================

  const profit =
    tradeAmount *
    (
      netPercent /
      100
    );

  const previousCapital =
    paper.capital;

  paper.capital += profit;

  paper.totalProfit += profit;

  paper.trades++;

  paper.volume += tradeAmount;

  if (profit > 0) {
    paper.winningTrades++;
  } else {
    paper.losingTrades++;
  }

  paper.lastTradeTime[symbol] =
    currentTime;

  stats.profitableOpportunities++;

  stats.lastOpportunity = {
    symbol,
    buyExchange,
    sellExchange,
    grossPercent,
    netPercent,
    profit,
    timestamp: new Date().toISOString()
  };

  // ==========================================================
  // REPORT
  // ==========================================================

  console.log("");

  console.log(
    "========================================================"
  );

  console.log(
    "🚨🚨🚨 PAPER TRADE ESEGUITO 🚨🚨🚨"
  );

  console.log(
    "========================================================"
  );

  console.log(
    `PAIR: ${symbol}`
  );

  console.log(
    `BUY:  ${buyExchange} @ ${buyPrice.toFixed(2)}`
  );

  console.log(
    `SELL: ${sellExchange} @ ${sellPrice.toFixed(2)}`
  );

  console.log(
    `SPREAD LORDO: ${pct(grossPercent)}`
  );

  console.log(
    `PROFITTO NETTO: ${pct(netPercent)}`
  );

  console.log(
    `CAPITALE OPERAZIONE: ${money(tradeAmount)}`
  );

  console.log(
    `PROFITTO: ${money(profit)}`
  );

  console.log(
    `CAPITALE PRIMA: ${money(previousCapital)}`
  );

  console.log(
    `CAPITALE DOPO: ${money(paper.capital)}`
  );

  console.log(
    `PROFITTO TOTALE: ${money(paper.totalProfit)}`
  );

  console.log(
    `OPERAZIONI TOTALI: ${paper.trades}`
  );

  console.log(
    "🔒 ORDINI REALI: DISABILITATI"
  );

  console.log(
    "========================================================"
  );

  console.log("");
}

// ============================================================
// PORTFOLIO REPORT
// ============================================================

function printPortfolio() {

  const roi =
    (
      paper.totalProfit /
      paper.initialCapital
    ) * 100;

  console.log("");

  console.log(
    "========================================================"
  );

  console.log(
    "💰 PAPER TRADING REPORT"
  );

  console.log(
    "========================================================"
  );

  console.log(
    `Capitale iniziale: ${money(paper.initialCapital)}`
  );

  console.log(
    `Capitale attuale:  ${money(paper.capital)}`
  );

  console.log(
    `Profitto totale:   ${money(paper.totalProfit)}`
  );

  console.log(
    `ROI:               ${pct(roi)}`
  );

  console.log(
    `Operazioni:        ${paper.trades}`
  );

  console.log(
    `Vincenti:          ${paper.winningTrades}`
  );

  console.log(
    `Perdenti:          ${paper.losingTrades}`
  );

  console.log(
    `Volume PAPER:      ${money(paper.volume)}`
  );

  console.log(
    `Controlli mercato: ${stats.checks}`
  );

  console.log(
    `Opportunità profittevoli: ${stats.profitableOpportunities}`
  );

  console.log("");

  console.log(
    `Coinbase messaggi: ${stats.coinbaseMessages}`
  );

  console.log(
    `Coinbase update:   ${stats.coinbaseUpdates}`
  );

  console.log(
    `OKX messaggi:      ${stats.okxMessages}`
  );

  console.log(
    `OKX update:        ${stats.okxUpdates}`
  );

  console.log("");

  console.log(
    `Soglia netto: ${CONFIG.minNetProfitPercent}%`
  );

  console.log(
    `Conferme richieste: ${CONFIG.requiredConfirmations}`
  );

  console.log(
    `Trade: ${CONFIG.tradePercentOfCapital}% del capitale`
  );

  console.log(
    `Commissione Coinbase: ${CONFIG.coinbaseFeePercent}%`
  );

  console.log(
    `Commissione OKX: ${CONFIG.okxFeePercent}%`
  );

  console.log(
    `Slippage Coinbase: ${CONFIG.coinbaseSlippagePercent}%`
  );

  console.log(
    `Slippage OKX: ${CONFIG.okxSlippagePercent}%`
  );

  console.log("");

  console.log(
    "🔒 ORDINI REALI: DISABILITATI"
  );

  console.log(
    "========================================================"
  );

  console.log("");
}

// ============================================================
// START
// ============================================================

log(
  "========================================================"
);

log(
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE v4"
);

log(
  "========================================================"
);

log(
  "Modalità: PAPER TRADING"
);

log(
  `Capitale iniziale: ${money(CONFIG.initialCapital)}`
);

log(
  `Trade: ${CONFIG.tradePercentOfCapital}% del capitale`
);

log(
  `Profitto netto minimo: ${CONFIG.minNetProfitPercent}%`
);

log(
  `Conferme richieste: ${CONFIG.requiredConfirmations}`
);

log(
  `Commissione Coinbase: ${CONFIG.coinbaseFeePercent}%`
);

log(
  `Commissione OKX: ${CONFIG.okxFeePercent}%`
);

log(
  `Slippage Coinbase: ${CONFIG.coinbaseSlippagePercent}%`
);

log(
  `Slippage OKX: ${CONFIG.okxSlippagePercent}%`
);

log(
  "🔒 ORDINI REALI: DISABILITATI"
);

log(
  "========================================================"
);

// ============================================================
// CONNESSIONI
// ============================================================

connectCoinbase();

connectOKX();

// ============================================================
// REPORT AUTOMATICO
// ============================================================

setInterval(
  printPortfolio,
  CONFIG.statusInterval
);

// ============================================================
// PROTEZIONE PROCESSO
// ============================================================

process.on(
  "uncaughtException",
  error => {

    log(
      `UNCAUGHT EXCEPTION: ${error.message}`
    );
  }
);

process.on(
  "unhandledRejection",
  error => {

    log(
      `UNHANDLED REJECTION: ${String(error)}`
    );
  }
);
