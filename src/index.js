const WebSocket = require("ws");

// ============================================================
// CRYPTO ARBITRAGE PAPER ENGINE
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

  // Percentuale del capitale utilizzata per ogni operazione
  tradePercentOfCapital: 20,

  // Profitto netto minimo richiesto
  minNetProfitPercent: 0.10,

  // Numero di conferme consecutive richieste
  requiredConfirmations: 3,

  // ==========================================================
  // COMMISSIONI
  // ==========================================================

  coinbaseFeePercent: 0.60,
  okxFeePercent: 0.10,

  // ==========================================================
  // SLIPPAGE
  // ==========================================================

  coinbaseSlippagePercent: 0.05,
  okxSlippagePercent: 0.05,

  // ==========================================================
  // CONVERSIONE USD / USDT
  // ==========================================================

  usdToUsdt: 1.0,

  // ==========================================================
  // TIMING
  // ==========================================================

  opportunityCooldown: 10000,
  reconnectDelay: 5000,

  // Report periodico
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
// MARKET BOOKS
// ============================================================

const books = {
  BTC: {
    coinbase: {
      bid: null,
      ask: null
    },

    okx: {
      bid: null,
      ask: null
    }
  },

  ETH: {
    coinbase: {
      bid: null,
      ask: null
    },

    okx: {
      bid: null,
      ask: null
    }
  }
};

// ============================================================
// CONFERME OPPORTUNITÀ
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

  opportunities: 0,

  profitableOpportunities: 0
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
  return `€${value.toFixed(2)}`;
}

function pct(value) {
  return `${value.toFixed(4)}%`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// PAIR LOOKUP
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
// COINBASE
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

      const symbol = getPairByCoinbaseProduct(
        ticker.product_id
      );

      if (!symbol) {
        continue;
      }

      const bid = Number(ticker.best_bid);
      const ask = Number(ticker.best_ask);

      let changed = false;

      if (
        Number.isFinite(bid) &&
        bid > 0
      ) {
        books[symbol].coinbase.bid = bid;
        changed = true;
      }

      if (
        Number.isFinite(ask) &&
        ask > 0
      ) {
        books[symbol].coinbase.ask = ask;
        changed = true;
      }

      if (changed) {
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
    log("Coinbase WebSocket CONNECTED");

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

    log("Coinbase subscriptions ATTIVE");
  });

  ws.on("message", raw => {
    try {
      stats.coinbaseMessages++;

      const data = JSON.parse(
        raw.toString()
      );

      updateCoinbase(data);

    } catch (error) {
      log(
        "Errore Coinbase: " +
        error.message
      );
    }
  });

  ws.on("close", () => {
    log(
      "Coinbase disconnesso. Riconnessione..."
    );

    setTimeout(
      connectCoinbase,
      CONFIG.reconnectDelay
    );
  });

  ws.on("error", error => {
    log(
      "Coinbase WebSocket error: " +
      error.message
    );
  });
}

// ============================================================
// OKX
// ============================================================

function updateOKX(data) {
  if (!data || !data.arg) {
    return;
  }

  if (data.arg.channel !== "books5") {
    return;
  }

  const symbol = getPairByOKXProduct(
    data.arg.instId
  );

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
    const bid = Number(
      book.bids[0][0]
    );

    if (
      Number.isFinite(bid) &&
      bid > 0
    ) {
      books[symbol].okx.bid = bid;
      changed = true;
    }
  }

  if (
    Array.isArray(book.asks) &&
    book.asks.length > 0
  ) {
    const ask = Number(
      book.asks[0][0]
    );

    if (
      Number.isFinite(ask) &&
      ask > 0
    ) {
      books[symbol].okx.ask = ask;
      changed = true;
    }
  }

  if (changed) {
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
    log("OKX WebSocket CONNECTED");

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

    log("OKX subscriptions ATTIVE");
  });

  ws.on("message", raw => {
    try {
      stats.okxMessages++;

      const text = raw.toString();

      // Ping testuale
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
          `OKX error ${data.code}: ${data.msg}`
        );

        return;
      }

      updateOKX(data);

    } catch (error) {
      log(
        "Errore OKX: " +
        error.message
      );
    }
  });

  ws.on("close", () => {
    log(
      "OKX disconnesso. Riconnessione..."
    );

    setTimeout(
      connectOKX,
      CONFIG.reconnectDelay
    );
  });

  ws.on("error", error => {
    log(
      "OKX WebSocket error: " +
      error.message
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
    !Number.isFinite(cb.bid) ||
    !Number.isFinite(cb.ask) ||
    !Number.isFinite(okx.bid) ||
    !Number.isFinite(okx.ask)
  ) {
    return;
  }

  // ==========================================================
  // CONVERSIONE USD / USDT
  // ==========================================================

  const okxBidUSD =
    okx.bid /
    CONFIG.usdToUsdt;

  const okxAskUSD =
    okx.ask /
    CONFIG.usdToUsdt;

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

  // Prezzo effettivo di acquisto
  const effectiveCBBuy =
    cb.ask *
    (
      1 +
      CONFIG.coinbaseSlippagePercent / 100
    );

  // Prezzo effettivo di vendita
  const effectiveOKXSell =
    okxBidUSD *
    (
      1 -
      CONFIG.okxSlippagePercent / 100
    );

  const netCBtoOKX =
    (
      (
        (
          effectiveOKXSell *
          (
            1 -
            CONFIG.okxFeePercent / 100
          )
        ) -
        (
          effectiveCBBuy *
          (
            1 +
            CONFIG.coinbaseFeePercent / 100
          )
        )
      ) /
      (
        effectiveCBBuy *
        (
          1 +
          CONFIG.coinbaseFeePercent / 100
        )
      )
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

  const netOKXtoCB =
    (
      (
        (
          effectiveCBSell *
          (
            1 -
            CONFIG.coinbaseFeePercent / 100
          )
        ) -
        (
          effectiveOKXBuy *
          (
            1 +
            CONFIG.okxFeePercent / 100
          )
        )
      ) /
      (
        effectiveOKXBuy *
        (
          1 +
          CONFIG.okxFeePercent / 100
        )
      )
    ) * 100;

  // ==========================================================
  // BREAK EVEN
  // ==========================================================

  const breakEven =
    CONFIG.coinbaseFeePercent +
    CONFIG.okxFeePercent +
    CONFIG.coinbaseSlippagePercent +
    CONFIG.okxSlippagePercent;

  stats.opportunities++;

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
    breakEven
  );

  // ==========================================================
  // PAPER TRADE
  // ==========================================================

  if (
    confirmations[symbol].cbToOkx >=
    CONFIG.requiredConfirmations
  ) {
    stats.profitableOpportunities++;

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

  if (
    confirmations[symbol].okxToCb >=
    CONFIG.requiredConfirmations
  ) {
    stats.profitableOpportunities++;

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
// MARKET STATUS
// ============================================================

function displayStatus(
  symbol,
  cb,
  okx,
  gross1,
  net1,
  gross2,
  net2,
  breakEven
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

  console.log(
    `CB -> OKX | Lordo: ${pct(gross1)} | Netto: ${pct(net1)}`
  );

  console.log(
    `OKX -> CB | Lordo: ${pct(gross2)} | Netto: ${pct(net2)}`
  );

  console.log(
    `Break-even: ${pct(breakEven)}`
  );

  console.log(
    `Conferma CB -> OKX: ${confirmations[symbol].cbToOkx}/${CONFIG.requiredConfirmations}`
  );

  console.log(
    `Conferma OKX -> CB: ${confirmations[symbol].okxToCb}/${CONFIG.requiredConfirmations}`
  );

  console.log(
    `💰 Capitale PAPER: ${money(paper.capital)}`
  );

  console.log(
    `💵 Profitto totale: ${money(paper.totalProfit)}`
  );

  console.log(
    `📈 Operazioni: ${paper.trades}`
  );

  console.log(
    `--------------------------------------------------------`
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
  const currentTime =
    Date.now();

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
  // CAPITALE OPERAZIONE
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
      netPercent / 100
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
// REPORT PORTAFOGLIO
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
    `Capitale iniziale: ${money(
      paper.initialCapital
    )}`
  );

  console.log(
    `Capitale attuale:  ${money(
      paper.capital
    )}`
  );

  console.log(
    `Profitto totale:   ${money(
      paper.totalProfit
    )}`
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
    `Volume PAPER:      ${money(
      paper.volume
    )}`
  );

  console.log(
    `Opportunità viste: ${stats.opportunities}`
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
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE v3"
);

log(
  "========================================================"
);

log(
  "Modalità: PAPER TRADING"
);

log(
  `Capitale iniziale: ${money(
    CONFIG.initialCapital
  )}`
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
      "UNCAUGHT EXCEPTION: " +
      error.message
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    log(
      "UNHANDLED REJECTION: " +
      String(error)
    );
  }
);
