const WebSocket = require("ws");

// ============================================================
// CONFIGURAZIONE
// ============================================================

const CONFIG = {
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

  // ----------------------------------------------------------
  // PAPER TRADING
  // ----------------------------------------------------------

  paperTrading: true,

  paperCapital: 1000,

  // Percentuale del capitale utilizzata per ogni trade
  tradeCapitalPercent: 20,

  // ----------------------------------------------------------
  // PROFITTO
  // ----------------------------------------------------------

  // Profitto netto minimo richiesto
  minNetProfitPercent: 0.10,

  // ----------------------------------------------------------
  // COMMISSIONI
  // ----------------------------------------------------------

  coinbaseFeePercent: 0.60,
  okxFeePercent: 0.10,

  // ----------------------------------------------------------
  // SLIPPAGE
  // ----------------------------------------------------------

  slippagePercentPerSide: 0.05,

  // ----------------------------------------------------------
  // CONFERME
  // ----------------------------------------------------------

  requiredConfirmations: 3,

  // ----------------------------------------------------------
  // QUOTE
  // ----------------------------------------------------------

  // Semplificazione PAPER:
  // 1 USD = 1 USDT
  usdToUsdt: 1.0,

  // ----------------------------------------------------------
  // TEMPI
  // ----------------------------------------------------------

  opportunityCooldown: 10000,

  reconnectDelay: 5000,

  statusInterval: 30000
};

// ============================================================
// ORDER BOOK
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
// STATO BOT
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

const lastOpportunity = {
  BTC: 0,
  ETH: 0
};

// ============================================================
// STATISTICHE
// ============================================================

const stats = {
  capital: CONFIG.paperCapital,

  initialCapital: CONFIG.paperCapital,

  profit: 0,

  operations: 0,

  winningOperations: 0,

  losingOperations: 0,

  volume: 0,

  opportunities: 0,

  coinbaseMessages: 0,

  coinbaseUpdates: 0,

  okxMessages: 0,

  okxUpdates: 0
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

function percent(value) {
  return `${value.toFixed(4)}%`;
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
  stats.coinbaseMessages++;

  if (!data || !Array.isArray(data.events)) {
    return;
  }

  for (const event of data.events) {
    if (!event) continue;

    if (!Array.isArray(event.tickers)) {
      continue;
    }

    for (const ticker of event.tickers) {
      if (!ticker) continue;

      const productId = ticker.product_id;

      const symbol =
        getPairByCoinbaseProduct(productId);

      if (!symbol) {
        continue;
      }

      const bestBid =
        Number(ticker.best_bid);

      const bestAsk =
        Number(ticker.best_ask);

      if (
        Number.isFinite(bestBid) &&
        bestBid > 0
      ) {
        books[symbol].coinbase.bid = bestBid;
      }

      if (
        Number.isFinite(bestAsk) &&
        bestAsk > 0
      ) {
        books[symbol].coinbase.ask = bestAsk;
      }

      stats.coinbaseUpdates++;

      checkArbitrage(symbol);
    }
  }
}

// ============================================================
// CONNECT COINBASE
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

  ws.on("message", (raw) => {
    try {
      const text = raw.toString();

      const data = JSON.parse(text);

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
      "Coinbase disconnesso. " +
      "Riconnessione..."
    );

    setTimeout(
      connectCoinbase,
      CONFIG.reconnectDelay
    );
  });

  ws.on("error", (error) => {
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
  stats.okxMessages++;

  if (!data || !data.arg) {
    return;
  }

  if (data.arg.channel !== "books5") {
    return;
  }

  const instId = data.arg.instId;

  const symbol =
    getPairByOKXProduct(instId);

  if (!symbol) {
    return;
  }

  const book = data.data?.[0];

  if (!book) {
    return;
  }

  if (
    Array.isArray(book.bids) &&
    book.bids.length > 0
  ) {
    const bid =
      Number(book.bids[0][0]);

    if (
      Number.isFinite(bid) &&
      bid > 0
    ) {
      books[symbol].okx.bid = bid;
    }
  }

  if (
    Array.isArray(book.asks) &&
    book.asks.length > 0
  ) {
    const ask =
      Number(book.asks[0][0]);

    if (
      Number.isFinite(ask) &&
      ask > 0
    ) {
      books[symbol].okx.ask = ask;
    }
  }

  stats.okxUpdates++;

  checkArbitrage(symbol);
}

// ============================================================
// CONNECT OKX
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

  ws.on("message", (raw) => {
    try {
      const text = raw.toString();

      if (text === "ping") {
        ws.send("pong");
        return;
      }

      const data =
        JSON.parse(text);

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
      "OKX disconnesso. " +
      "Riconnessione..."
    );

    setTimeout(
      connectOKX,
      CONFIG.reconnectDelay
    );
  });

  ws.on("error", (error) => {
    log(
      "OKX WebSocket error: " +
      error.message
    );
  });
}

// ============================================================
// CALCOLO COSTI
// ============================================================

function calculateNetProfit(
  grossSpread,
  buyFee,
  sellFee
) {
  const fees =
    buyFee +
    sellFee;

  const slippage =
    CONFIG.slippagePercentPerSide * 2;

  return (
    grossSpread -
    fees -
    slippage
  );
}

// ============================================================
// BREAK EVEN
// ============================================================

function getBreakEven(
  buyFee,
  sellFee
) {
  return (
    buyFee +
    sellFee +
    CONFIG.slippagePercentPerSide * 2
  );
}

// ============================================================
// ARBITRAGGIO
// ============================================================

function checkArbitrage(symbol) {
  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;

  if (
    !cb.bid ||
    !cb.ask ||
    !okx.bid ||
    !okx.ask
  ) {
    return;
  }

  // ----------------------------------------------------------
  // USD / USDT
  // ----------------------------------------------------------

  const okxBidInUsd =
    okx.bid /
    CONFIG.usdToUsdt;

  const okxAskInUsd =
    okx.ask /
    CONFIG.usdToUsdt;

  // ----------------------------------------------------------
  // CB -> OKX
  //
  // Compra Coinbase
  // Vendi OKX
  // ----------------------------------------------------------

  const grossCbToOkx =
    (
      (okxBidInUsd - cb.ask) /
      cb.ask
    ) * 100;

  const netCbToOkx =
    calculateNetProfit(
      grossCbToOkx,
      CONFIG.coinbaseFeePercent,
      CONFIG.okxFeePercent
    );

  // ----------------------------------------------------------
  // OKX -> CB
  //
  // Compra OKX
  // Vendi Coinbase
  // ----------------------------------------------------------

  const grossOkxToCb =
    (
      (cb.bid - okxAskInUsd) /
      okxAskInUsd
    ) * 100;

  const netOkxToCb =
    calculateNetProfit(
      grossOkxToCb,
      CONFIG.okxFeePercent,
      CONFIG.coinbaseFeePercent
    );

  // ----------------------------------------------------------
  // BREAK EVEN
  // ----------------------------------------------------------

  const breakEvenCbToOkx =
    getBreakEven(
      CONFIG.coinbaseFeePercent,
      CONFIG.okxFeePercent
    );

  const breakEvenOkxToCb =
    getBreakEven(
      CONFIG.okxFeePercent,
      CONFIG.coinbaseFeePercent
    );

  // ----------------------------------------------------------
  // CONFERME
  // ----------------------------------------------------------

  if (
    netCbToOkx >=
    CONFIG.minNetProfitPercent
  ) {
    confirmations[symbol].cbToOkx++;
  } else {
    confirmations[symbol].cbToOkx = 0;
  }

  if (
    netOkxToCb >=
    CONFIG.minNetProfitPercent
  ) {
    confirmations[symbol].okxToCb++;
  } else {
    confirmations[symbol].okxToCb = 0;
  }

  // ----------------------------------------------------------
  // LOG
  // ----------------------------------------------------------

  printMarketStatus(
    symbol,
    cb,
    okx,
    grossCbToOkx,
    netCbToOkx,
    grossOkxToCb,
    netOkxToCb,
    breakEvenCbToOkx,
    breakEvenOkxToCb
  );

  // ----------------------------------------------------------
  // OPPORTUNITÀ
  // ----------------------------------------------------------

  if (
    confirmations[symbol].cbToOkx >=
    CONFIG.requiredConfirmations
  ) {
    executePaperTrade(
      symbol,
      "Coinbase",
      cb.ask,
      "OKX",
      okxBidInUsd,
      netCbToOkx
    );

    confirmations[symbol].cbToOkx = 0;
  }

  if (
    confirmations[symbol].okxToCb >=
    CONFIG.requiredConfirmations
  ) {
    executePaperTrade(
      symbol,
      "OKX",
      okxAskInUsd,
      "Coinbase",
      cb.bid,
      netOkxToCb
    );

    confirmations[symbol].okxToCb = 0;
  }
}

// ============================================================
// MARKET STATUS
// ============================================================

function printMarketStatus(
  symbol,
  cb,
  okx,
  grossCbToOkx,
  netCbToOkx,
  grossOkxToCb,
  netOkxToCb,
  breakEvenCbToOkx,
  breakEvenOkxToCb
) {
  console.log("");

  console.log(
    "--------------------------------------------------"
  );

  console.log(`📊 ${symbol}`);

  console.log(
    `Coinbase -> BID: ${cb.bid.toFixed(2)} | ASK: ${cb.ask.toFixed(2)}`
  );

  console.log(
    `OKX      -> BID: ${okx.bid.toFixed(2)} | ASK: ${okx.ask.toFixed(2)}`
  );

  console.log("");

  console.log(
    `CB -> OKX | Lordo: ${percent(grossCbToOkx)} | Netto: ${percent(netCbToOkx)}`
  );

  console.log(
    `OKX -> CB | Lordo: ${percent(grossOkxToCb)} | Netto: ${percent(netOkxToCb)}`
  );

  console.log("");

  console.log(
    `Break-even CB -> OKX: ${percent(breakEvenCbToOkx)}`
  );

  console.log(
    `Break-even OKX -> CB: ${percent(breakEvenOkxToCb)}`
  );

  console.log("");

  console.log(
    `Conferma CB -> OKX: ${confirmations[symbol].cbToOkx}/${CONFIG.requiredConfirmations}`
  );

  console.log(
    `Conferma OKX -> CB: ${confirmations[symbol].okxToCb}/${CONFIG.requiredConfirmations}`
  );

  console.log(
    "--------------------------------------------------"
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
  netProfitPercent
) {
  const currentTime =
    Date.now();

  if (
    currentTime -
      lastOpportunity[symbol] <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  lastOpportunity[symbol] =
    currentTime;

  stats.opportunities++;

  const tradeCapital =
    stats.capital *
    (
      CONFIG.tradeCapitalPercent /
      100
    );

  const estimatedProfit =
    tradeCapital *
    (
      netProfitPercent /
      100
    );

  stats.operations++;

  stats.volume +=
    tradeCapital;

  stats.profit +=
    estimatedProfit;

  stats.capital +=
    estimatedProfit;

  if (estimatedProfit >= 0) {
    stats.winningOperations++;
  } else {
    stats.losingOperations++;
  }

  console.log("");

  console.log(
    "=================================================="
  );

  console.log(
    "🚨🚨 OPPORTUNITÀ ARBITRAGGIO CONFERMATA 🚨🚨"
  );

  console.log(
    "=================================================="
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
    `PROFITTO NETTO: ${percent(netProfitPercent)}`
  );

  console.log(
    `CAPITALE TRADE: ${money(tradeCapital)}`
  );

  console.log(
    `PROFITTO STIMATO: ${money(estimatedProfit)}`
  );

  console.log(
    `CAPITALE DOPO TRADE: ${money(stats.capital)}`
  );

  console.log(
    "MODE: PAPER TRADING"
  );

  console.log(
    "REAL ORDERS: DISABLED"
  );

  console.log(
    "=================================================="
  );

  console.log("");
}

// ============================================================
// STATUS GENERALE
// ============================================================

function printGlobalStatus() {
  console.log("");

  console.log(
    "=================================================="
  );

  console.log(
    `💰 Capitale PAPER: ${money(stats.capital)}`
  );

  console.log(
    `💵 Profitto totale: ${money(stats.profit)}`
  );

  console.log(
    `📈 Operazioni: ${stats.operations}`
  );

  console.log(
    `✅ Vincenti: ${stats.winningOperations}`
  );

  console.log(
    `❌ Perdenti: ${stats.losingOperations}`
  );

  console.log(
    `🔄 Volume PAPER: ${money(stats.volume)}`
  );

  console.log("");

  console.log(
    `Coinbase messaggi: ${stats.coinbaseMessages} | Aggiornamenti: ${stats.coinbaseUpdates}`
  );

  console.log(
    `OKX messaggi: ${stats.okxMessages} | Aggiornamenti: ${stats.okxUpdates}`
  );

  console.log("");

  console.log(
    `Soglia netto: ${CONFIG.minNetProfitPercent}%`
  );

  console.log(
    `Conferme richieste: ${CONFIG.requiredConfirmations}`
  );

  console.log(
    `Trade: ${CONFIG.tradeCapitalPercent}% capitale`
  );

  console.log(
    `Commissione Coinbase: ${CONFIG.coinbaseFeePercent}%`
  );

  console.log(
    `Commissione OKX: ${CONFIG.okxFeePercent}%`
  );

  console.log(
    `Slippage: ${CONFIG.slippagePercentPerSide}% per lato`
  );

  console.log("");

  console.log(
    "REAL ORDERS: DISABLED"
  );

  console.log(
    "=================================================="
  );

  console.log("");
}

// ============================================================
// AVVIO
// ============================================================

log(
  "=================================================="
);

log(
  "🚀 Crypto Arbitrage Scanner avviato"
);

log(
  "=================================================="
);

log(
  "Modalità: PAPER TRADING"
);

log(
  `Capitale PAPER: ${money(CONFIG.paperCapital)}`
);

log(
  "Ordini reali: DISABILITATI"
);

log(
  "Coppie: BTC, ETH"
);

log(
  "Coinbase: BTC-USD / ETH-USD"
);

log(
  "OKX: BTC-USDT / ETH-USDT"
);

log(
  `Soglia profitto netto: ${CONFIG.minNetProfitPercent}%`
);

log(
  `Conferme richieste: ${CONFIG.requiredConfirmations}`
);

log(
  `Trade: ${CONFIG.tradeCapitalPercent}% del capitale`
);

log(
  "=================================================="
);

connectCoinbase();

connectOKX();

// ============================================================
// STATUS PERIODICO
// ============================================================

setInterval(() => {
  printGlobalStatus();
}, CONFIG.statusInterval);
