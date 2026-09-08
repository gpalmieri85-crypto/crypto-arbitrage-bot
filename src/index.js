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

  // ==========================================================
  // PAPER TRADING
  // ==========================================================

  initialCapital: 1000,

  // Percentuale del capitale utilizzata per ogni operazione
  tradePercentOfCapital: 20,

  // Profitto netto minimo necessario per eseguire un'operazione
  minNetProfitPercent: 0.10,

  // Commissioni simulate
  coinbaseFeePercent: 0.60,
  okxFeePercent: 0.10,

  // Slippage prudenziale simulato per lato
  slippagePercent: 0.05,

  // USD ≈ USDT nel modello PAPER
  usdToUsdt: 1.0,

  // Nessun ordine reale
  paperTrading: true,

  // Evita operazioni troppo ravvicinate
  opportunityCooldown: 10000,

  // Tempo massimo di validità dei prezzi
  maxPriceAge: 5000,

  // Riconnessione WebSocket
  reconnectDelay: 5000,

  // Stampa situazione generale ogni 10 secondi
  statusInterval: 10000
};

// ============================================================
// ORDER BOOK
// ============================================================

const books = {
  BTC: {
    coinbase: {
      bid: null,
      ask: null,
      updatedAt: 0
    },
    okx: {
      bid: null,
      ask: null,
      updatedAt: 0
    }
  },

  ETH: {
    coinbase: {
      bid: null,
      ask: null,
      updatedAt: 0
    },
    okx: {
      bid: null,
      ask: null,
      updatedAt: 0
    }
  }
};

// ============================================================
// PAPER PORTFOLIO
// ============================================================

const portfolio = {
  startingCapital: CONFIG.initialCapital,
  capital: CONFIG.initialCapital,
  totalProfit: 0,
  operations: 0,
  winningOperations: 0,
  losingOperations: 0
};

// ============================================================
// CONTROLLO OPPORTUNITÀ
// ============================================================

const opportunityState = {
  BTC: {
    cbToOkxArmed: true,
    okxToCbArmed: true,
    lastTradeCbToOkx: 0,
    lastTradeOkxToCb: 0
  },

  ETH: {
    cbToOkxArmed: true,
    okxToCbArmed: true,
    lastTradeCbToOkx: 0,
    lastTradeOkxToCb: 0
  }
};

// ============================================================
// STATISTICHE WEBSOCKET
// ============================================================

const stats = {
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function isFresh(book) {
  if (!book.updatedAt) {
    return false;
  }

  return Date.now() - book.updatedAt <= CONFIG.maxPriceAge;
}

// ============================================================
// CALCOLO NETTO
// ============================================================

function calculateNetProfitPercent(
  buyPrice,
  sellPrice,
  buyFeePercent,
  sellFeePercent
) {
  if (
    !Number.isFinite(buyPrice) ||
    !Number.isFinite(sellPrice) ||
    buyPrice <= 0 ||
    sellPrice <= 0
  ) {
    return -Infinity;
  }

  const buyCost =
    buyPrice *
    (1 + (buyFeePercent + CONFIG.slippagePercent) / 100);

  const sellRevenue =
    sellPrice *
    (1 - (sellFeePercent + CONFIG.slippagePercent) / 100);

  return ((sellRevenue - buyCost) / buyCost) * 100;
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
    if (!event) {
      continue;
    }

    if (!Array.isArray(event.tickers)) {
      continue;
    }

    for (const ticker of event.tickers) {
      if (!ticker) {
        continue;
      }

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

      books[symbol].coinbase.updatedAt = Date.now();

      stats.coinbaseUpdates++;

      checkArbitrage(symbol);
    }
  }
}

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
      const text = raw.toString();

      if (!text) {
        return;
      }

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

  books[symbol].okx.updatedAt = Date.now();

  stats.okxUpdates++;

  checkArbitrage(symbol);
}

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
          `OKX subscription error ` +
          `${data.code}: ${data.msg}`
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
  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;

  // Non calcoliamo se i prezzi non sono disponibili
  if (
    !cb.bid ||
    !cb.ask ||
    !okx.bid ||
    !okx.ask
  ) {
    return;
  }

  // Evita di utilizzare prezzi vecchi
  if (
    !isFresh(cb) ||
    !isFresh(okx)
  ) {
    return;
  }

  const okxBidInUsd =
    okx.bid /
    CONFIG.usdToUsdt;

  const okxAskInUsd =
    okx.ask /
    CONFIG.usdToUsdt;

  // ==========================================================
  // COINBASE -> OKX
  //
  // Compra su Coinbase ASK
  // Vendi su OKX BID
  // ==========================================================

  const cbToOkxGross =
    (
      (okxBidInUsd - cb.ask) /
      cb.ask
    ) * 100;

  const cbToOkxNet =
    calculateNetProfitPercent(
      cb.ask,
      okxBidInUsd,
      CONFIG.coinbaseFeePercent,
      CONFIG.okxFeePercent
    );

  // ==========================================================
  // OKX -> COINBASE
  //
  // Compra su OKX ASK
  // Vendi su Coinbase BID
  // ==========================================================

  const okxToCbGross =
    (
      (cb.bid - okxAskInUsd) /
      okxAskInUsd
    ) * 100;

  const okxToCbNet =
    calculateNetProfitPercent(
      okxAskInUsd,
      cb.bid,
      CONFIG.okxFeePercent,
      CONFIG.coinbaseFeePercent
    );

  // ==========================================================
  // OPPORTUNITÀ
  // ==========================================================

  if (
    cbToOkxNet >=
    CONFIG.minNetProfitPercent
  ) {
    if (
      opportunityState[symbol]
        .cbToOkxArmed
    ) {
      executePaperTrade(
        symbol,
        "Coinbase",
        cb.ask,
        "OKX",
        okxBidInUsd,
        cbToOkxGross,
        cbToOkxNet,
        "cbToOkx"
      );
    }
  } else if (
    cbToOkxNet <
    CONFIG.minNetProfitPercent - 0.05
  ) {
    opportunityState[symbol]
      .cbToOkxArmed = true;
  }

  if (
    okxToCbNet >=
    CONFIG.minNetProfitPercent
  ) {
    if (
      opportunityState[symbol]
        .okxToCbArmed
    ) {
      executePaperTrade(
        symbol,
        "OKX",
        okxAskInUsd,
        "Coinbase",
        cb.bid,
        okxToCbGross,
        okxToCbNet,
        "okxToCb"
      );
    }
  } else if (
    okxToCbNet <
    CONFIG.minNetProfitPercent - 0.05
  ) {
    opportunityState[symbol]
      .okxToCbArmed = true;
  }
}

// ============================================================
// ESECUZIONE PAPER TRADE
// ============================================================

function executePaperTrade(
  symbol,
  buyExchange,
  buyPrice,
  sellExchange,
  sellPrice,
  grossPercent,
  netPercent,
  direction
) {
  const state =
    opportunityState[symbol];

  const nowMs = Date.now();

  const lastTrade =
    direction === "cbToOkx"
      ? state.lastTradeCbToOkx
      : state.lastTradeOkxToCb;

  // Cooldown
  if (
    nowMs - lastTrade <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  // Disarma l'opportunità
  if (direction === "cbToOkx") {
    state.cbToOkxArmed = false;
    state.lastTradeCbToOkx = nowMs;
  } else {
    state.okxToCbArmed = false;
    state.lastTradeOkxToCb = nowMs;
  }

  // ==========================================================
  // DIMENSIONE OPERAZIONE
  // ==========================================================

  const tradeCapital =
    portfolio.capital *
    (
      CONFIG.tradePercentOfCapital /
      100
    );

  if (tradeCapital <= 0) {
    return;
  }

  // Profitto simulato
  const profit =
    tradeCapital *
    (netPercent / 100);

  const capitalBefore =
    portfolio.capital;

  portfolio.totalProfit += profit;

  portfolio.capital += profit;

  portfolio.operations++;

  if (profit > 0) {
    portfolio.winningOperations++;
  } else {
    portfolio.losingOperations++;
  }

  // ==========================================================
  // LOG OPERAZIONE
  // ==========================================================

  console.log("");

  console.log(
    "================================================"
  );

  console.log(
    "🚨 PAPER ARBITRAGE ESEGUITO"
  );

  console.log(
    "================================================"
  );

  console.log(
    `PAIR: ${symbol}`
  );

  console.log(
    `BUY:  ${buyExchange} @ ` +
    `${buyPrice.toFixed(2)}`
  );

  console.log(
    `SELL: ${sellExchange} @ ` +
    `${sellPrice.toFixed(2)}`
  );

  console.log(
    `SPREAD LORDO: ` +
    `${grossPercent.toFixed(4)}%`
  );

  console.log(
    `PROFITTO NETTO: ` +
    `${netPercent.toFixed(4)}%`
  );

  console.log(
    `CAPITALE OPERAZIONE: ` +
    `€${tradeCapital.toFixed(2)}`
  );

  console.log(
    `PROFITTO OPERAZIONE: ` +
    `€${profit.toFixed(4)}`
  );

  console.log(
    `CAPITALE PRIMA: ` +
    `€${capitalBefore.toFixed(2)}`
  );

  console.log(
    `CAPITALE DOPO: ` +
    `€${portfolio.capital.toFixed(2)}`
  );

  console.log(
    `PROFITTO TOTALE: ` +
    `€${portfolio.totalProfit.toFixed(4)}`
  );

  console.log(
    `OPERAZIONI TOTALI: ` +
    `${portfolio.operations}`
  );

  console.log(
    "MODE: PAPER TRADING"
  );

  console.log(
    "REAL ORDERS: DISABLED"
  );

  console.log(
    "================================================"
  );

  console.log("");
}

// ============================================================
// STATO
// ============================================================

function printStatus() {
  console.log("");

  console.log(
    "================================================"
  );

  console.log(
    `STATUS ${now()}`
  );

  console.log(
    "================================================"
  );

  for (const symbol of ["BTC", "ETH"]) {
    const cb =
      books[symbol].coinbase;

    const okx =
      books[symbol].okx;

    console.log("");

    console.log(
      `📊 ${symbol}`
    );

    if (
      cb.bid &&
      cb.ask &&
      okx.bid &&
      okx.ask
    ) {
      const cbToOkxNet =
        calculateNetProfitPercent(
          cb.ask,
          okx.bid,
          CONFIG.coinbaseFeePercent,
          CONFIG.okxFeePercent
        );

      const okxToCbNet =
        calculateNetProfitPercent(
          okx.ask,
          cb.bid,
          CONFIG.okxFeePercent,
          CONFIG.coinbaseFeePercent
        );

      const cbToOkxGross =
        (
          (okx.bid - cb.ask) /
          cb.ask
        ) * 100;

      const okxToCbGross =
        (
          (cb.bid - okx.ask) /
          okx.ask
        ) * 100;

      console.log(
        `Coinbase -> BID: ` +
        `${cb.bid.toFixed(2)} | ASK: ` +
        `${cb.ask.toFixed(2)}`
      );

      console.log(
        `OKX      -> BID: ` +
        `${okx.bid.toFixed(2)} | ASK: ` +
        `${okx.ask.toFixed(2)}`
      );

      console.log(
        `CB -> OKX | Lordo: ` +
        `${cbToOkxGross.toFixed(4)}% | ` +
        `Netto: ${cbToOkxNet.toFixed(4)}%`
      );

      console.log(
        `OKX -> CB | Lordo: ` +
        `${okxToCbGross.toFixed(4)}% | ` +
        `Netto: ${okxToCbNet.toFixed(4)}%`
      );

      if (
        cbToOkxNet >=
        CONFIG.minNetProfitPercent
      ) {
        console.log(
          `🚨 OPPORTUNITÀ CB -> OKX`
        );
      }

      if (
        okxToCbNet >=
        CONFIG.minNetProfitPercent
      ) {
        console.log(
          `🚨 OPPORTUNITÀ OKX -> CB`
        );
      }
    } else {
      console.log(
        "In attesa dei prezzi..."
      );
    }
  }

  console.log("");

  console.log(
    "------------------------------------------------"
  );

  console.log(
    `💰 Capitale PAPER: ` +
    `€${portfolio.capital.toFixed(2)}`
  );

  console.log(
    `💵 Profitto totale: ` +
    `€${portfolio.totalProfit.toFixed(4)}`
  );

  console.log(
    `📈 Operazioni: ` +
    `${portfolio.operations}`
  );

  console.log(
    `✅ Operazioni vincenti: ` +
    `${portfolio.winningOperations}`
  );

  console.log(
    `❌ Operazioni perdenti: ` +
    `${portfolio.losingOperations}`
  );

  console.log("");

  console.log(
    `Coinbase messaggi: ` +
    `${stats.coinbaseMessages} | ` +
    `Aggiornamenti: ${stats.coinbaseUpdates}`
  );

  console.log(
    `OKX messaggi: ` +
    `${stats.okxMessages} | ` +
    `Aggiornamenti: ${stats.okxUpdates}`
  );

  console.log(
    "------------------------------------------------"
  );

  console.log(
    `Soglia profitto netto: ` +
    `${CONFIG.minNetProfitPercent.toFixed(2)}%`
  );

  console.log(
    `Commissione Coinbase: ` +
    `${CONFIG.coinbaseFeePercent}%`
  );

  console.log(
    `Commissione OKX: ` +
    `${CONFIG.okxFeePercent}%`
  );

  console.log(
    `Slippage simulato: ` +
    `${CONFIG.slippagePercent}% per lato`
  );

  console.log(
    "================================================"
  );

  console.log("");
}

// ============================================================
// AVVIO
// ============================================================

log(
  "================================================"
);

log(
  "🚀 CRYPTO ARBITRAGE SCANNER AVVIATO"
);

log(
  "================================================"
);

log(
  "Modalità: PAPER TRADING"
);

log(
  `Capitale iniziale: €` +
  `${CONFIG.initialCapital.toFixed(2)}`
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
  `Profitto netto minimo: ` +
  `${CONFIG.minNetProfitPercent}%`
);

log(
  `Trade per operazione: ` +
  `${CONFIG.tradePercentOfCapital}% del capitale`
);

log(
  "================================================"
);

connectCoinbase();
connectOKX();

// ============================================================
// STATUS PERIODICO
// ============================================================

setInterval(() => {
  printStatus();
}, CONFIG.statusInterval);

// ============================================================
// PROTEZIONE PROCESSO
// ============================================================

process.on("uncaughtException", error => {
  log(
    "UNCAUGHT EXCEPTION: " +
    error.message
  );
});

process.on("unhandledRejection", error => {
  log(
    "UNHANDLED REJECTION: " +
    String(error)
  );
});
