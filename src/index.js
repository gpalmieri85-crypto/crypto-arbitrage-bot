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

  // Profitto netto minimo richiesto
  minNetProfitPercent: 0.10,

  // Numero di conferme consecutive necessarie
  requiredConfirmations: 3,

  // Commissioni simulate
  coinbaseFeePercent: 0.60,
  okxFeePercent: 0.10,

  // Slippage simulato per ogni lato
  slippagePercent: 0.05,

  // USD ≈ USDT
  usdToUsdt: 1.0,

  // SICUREZZA
  paperTrading: true,
  realOrdersEnabled: false,

  // Evita operazioni ripetute troppo velocemente
  opportunityCooldown: 10000,

  // Prezzi considerati validi solo se recenti
  maxPriceAge: 5000,

  // Riconnessione
  reconnectDelay: 5000,

  // Status
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
      bidSize: null,
      askSize: null,
      updatedAt: 0
    },

    okx: {
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      updatedAt: 0
    }
  },

  ETH: {
    coinbase: {
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      updatedAt: 0
    },

    okx: {
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      updatedAt: 0
    }
  }
};

// ============================================================
// PORTAFOGLIO PAPER
// ============================================================

const portfolio = {
  startingCapital: CONFIG.initialCapital,
  capital: CONFIG.initialCapital,

  totalProfit: 0,

  operations: 0,
  winningOperations: 0,
  losingOperations: 0,

  totalVolume: 0
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
// ULTIMA OPERAZIONE
// ============================================================

const lastTrade = {
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

  return (
    Date.now() - book.updatedAt <=
    CONFIG.maxPriceAge
  );
}

// ============================================================
// CALCOLO PROFITTO NETTO
// ============================================================

function calculateNetProfitPercent(
  buyPrice,
  sellPrice,
  buyFee,
  sellFee
) {
  if (
    !Number.isFinite(buyPrice) ||
    !Number.isFinite(sellPrice) ||
    buyPrice <= 0 ||
    sellPrice <= 0
  ) {
    return -Infinity;
  }

  const effectiveBuyPrice =
    buyPrice *
    (
      1 +
      (
        buyFee +
        CONFIG.slippagePercent
      ) / 100
    );

  const effectiveSellPrice =
    sellPrice *
    (
      1 -
      (
        sellFee +
        CONFIG.slippagePercent
      ) / 100
    );

  return (
    (
      (
        effectiveSellPrice -
        effectiveBuyPrice
      ) /
      effectiveBuyPrice
    ) *
    100
  );
}

// ============================================================
// COINBASE
// ============================================================

function updateCoinbase(data) {
  stats.coinbaseMessages++;

  if (
    !data ||
    !Array.isArray(data.events)
  ) {
    return;
  }

  for (const event of data.events) {
    if (!event) {
      continue;
    }

    if (
      !Array.isArray(event.tickers)
    ) {
      continue;
    }

    for (const ticker of event.tickers) {
      if (!ticker) {
        continue;
      }

      const symbol =
        getPairByCoinbaseProduct(
          ticker.product_id
        );

      if (!symbol) {
        continue;
      }

      const bid =
        Number(ticker.best_bid);

      const ask =
        Number(ticker.best_ask);

      const bidSize =
        Number(ticker.best_bid_quantity);

      const askSize =
        Number(ticker.best_ask_quantity);

      if (
        Number.isFinite(bid) &&
        bid > 0
      ) {
        books[symbol]
          .coinbase
          .bid = bid;
      }

      if (
        Number.isFinite(ask) &&
        ask > 0
      ) {
        books[symbol]
          .coinbase
          .ask = ask;
      }

      if (
        Number.isFinite(bidSize) &&
        bidSize > 0
      ) {
        books[symbol]
          .coinbase
          .bidSize = bidSize;
      }

      if (
        Number.isFinite(askSize) &&
        askSize > 0
      ) {
        books[symbol]
          .coinbase
          .askSize = askSize;
      }

      books[symbol]
        .coinbase
        .updatedAt = Date.now();

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
    log(
      "Coinbase WebSocket CONNECTED"
    );

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

    log(
      "Coinbase subscriptions ATTIVE"
    );
  });

  ws.on("message", raw => {
    try {
      const text = raw.toString();

      if (!text) {
        return;
      }

      const data =
        JSON.parse(text);

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

  if (
    !data ||
    !data.arg
  ) {
    return;
  }

  if (
    data.arg.channel !==
    "books5"
  ) {
    return;
  }

  const symbol =
    getPairByOKXProduct(
      data.arg.instId
    );

  if (!symbol) {
    return;
  }

  const book =
    data.data?.[0];

  if (!book) {
    return;
  }

  if (
    Array.isArray(book.bids) &&
    book.bids.length > 0
  ) {
    const bid =
      Number(book.bids[0][0]);

    const bidSize =
      Number(book.bids[0][1]);

    if (
      Number.isFinite(bid) &&
      bid > 0
    ) {
      books[symbol]
        .okx
        .bid = bid;
    }

    if (
      Number.isFinite(bidSize) &&
      bidSize > 0
    ) {
      books[symbol]
        .okx
        .bidSize = bidSize;
    }
  }

  if (
    Array.isArray(book.asks) &&
    book.asks.length > 0
  ) {
    const ask =
      Number(book.asks[0][0]);

    const askSize =
      Number(book.asks[0][1]);

    if (
      Number.isFinite(ask) &&
      ask > 0
    ) {
      books[symbol]
        .okx
        .ask = ask;
    }

    if (
      Number.isFinite(askSize) &&
      askSize > 0
    ) {
      books[symbol]
        .okx
        .askSize = askSize;
    }
  }

  books[symbol]
    .okx
    .updatedAt = Date.now();

  stats.okxUpdates++;

  checkArbitrage(symbol);
}

function connectOKX() {
  const ws = new WebSocket(
    "wss://ws.okx.com:8443/ws/v5/public"
  );

  ws.on("open", () => {
    log(
      "OKX WebSocket CONNECTED"
    );

    ws.send(
      JSON.stringify({
        op: "subscribe",
        args: [
          {
            channel: "books5",
            instId:
              CONFIG.pairs.BTC.okx
          },
          {
            channel: "books5",
            instId:
              CONFIG.pairs.ETH.okx
          }
        ]
      })
    );

    log(
      "OKX subscriptions ATTIVE"
    );
  });

  ws.on("message", raw => {
    try {
      const text =
        raw.toString();

      if (text === "ping") {
        ws.send("pong");
        return;
      }

      if (!text) {
        return;
      }

      const data =
        JSON.parse(text);

      if (
        data.event ===
        "subscribe"
      ) {
        return;
      }

      if (
        data.event ===
        "error"
      ) {
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

  ws.on("error", error => {
    log(
      "OKX WebSocket error: " +
      error.message
    );
  });
}

// ============================================================
// VERIFICA ARBITRAGGIO
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

  if (
    !isFresh(cb) ||
    !isFresh(okx)
  ) {
    return;
  }

  // ==========================================================
  // COINBASE -> OKX
  // ==========================================================

  const cbToOkxGross =
    (
      (okx.bid - cb.ask) /
      cb.ask
    ) * 100;

  const cbToOkxNet =
    calculateNetProfitPercent(
      cb.ask,
      okx.bid,
      CONFIG.coinbaseFeePercent,
      CONFIG.okxFeePercent
    );

  // ==========================================================
  // OKX -> COINBASE
  // ==========================================================

  const okxToCbGross =
    (
      (cb.bid - okx.ask) /
      okx.ask
    ) * 100;

  const okxToCbNet =
    calculateNetProfitPercent(
      okx.ask,
      cb.bid,
      CONFIG.okxFeePercent,
      CONFIG.coinbaseFeePercent
    );

  // ==========================================================
  // CONFERMA CB -> OKX
  // ==========================================================

  if (
    cbToOkxNet >=
    CONFIG.minNetProfitPercent
  ) {
    confirmations[symbol]
      .cbToOkx++;

    confirmations[symbol]
      .okxToCb = 0;

    if (
      confirmations[symbol]
        .cbToOkx >=
      CONFIG.requiredConfirmations
    ) {
      executePaperTrade(
        symbol,
        "Coinbase",
        cb.ask,
        "OKX",
        okx.bid,
        cb.askSize,
        okx.bidSize,
        cbToOkxGross,
        cbToOkxNet,
        "cbToOkx"
      );
    }
  } else {
    confirmations[symbol]
      .cbToOkx = 0;
  }

  // ==========================================================
  // CONFERMA OKX -> COINBASE
  // ==========================================================

  if (
    okxToCbNet >=
    CONFIG.minNetProfitPercent
  ) {
    confirmations[symbol]
      .okxToCb++;

    confirmations[symbol]
      .cbToOkx = 0;

    if (
      confirmations[symbol]
        .okxToCb >=
      CONFIG.requiredConfirmations
    ) {
      executePaperTrade(
        symbol,
        "OKX",
        okx.ask,
        "Coinbase",
        cb.bid,
        okx.askSize,
        cb.bidSize,
        okxToCbGross,
        okxToCbNet,
        "okxToCb"
      );
    }
  } else {
    confirmations[symbol]
      .okxToCb = 0;
  }
}

// ============================================================
// ESECUZIONE PAPER
// ============================================================

function executePaperTrade(
  symbol,
  buyExchange,
  buyPrice,
  sellExchange,
  sellPrice,
  buyLiquidity,
  sellLiquidity,
  grossPercent,
  netPercent,
  direction
) {
  if (!CONFIG.paperTrading) {
    return;
  }

  if (CONFIG.realOrdersEnabled) {
    log(
      "BLOCCO SICUREZZA: " +
      "ordini reali disabilitati."
    );

    return;
  }

  const currentTime =
    Date.now();

  const previousTrade =
    lastTrade[symbol][direction];

  if (
    currentTime -
    previousTrade <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  lastTrade[symbol][direction] =
    currentTime;

  // ==========================================================
  // CAPITALE OPERAZIONE
  // ==========================================================

  const desiredCapital =
    portfolio.capital *
    (
      CONFIG.tradePercentOfCapital /
      100
    );

  if (
    desiredCapital <= 0
  ) {
    return;
  }

  // ==========================================================
  // QUANTITÀ ACQUISTABILE
  // ==========================================================

  const quantityFromCapital =
    desiredCapital /
    buyPrice;

  let executableQuantity =
    quantityFromCapital;

  // Controllo liquidità lato BUY
  if (
    Number.isFinite(buyLiquidity) &&
    buyLiquidity > 0
  ) {
    executableQuantity =
      Math.min(
        executableQuantity,
        buyLiquidity
      );
  }

  // Controllo liquidità lato SELL
  if (
    Number.isFinite(sellLiquidity) &&
    sellLiquidity > 0
  ) {
    executableQuantity =
      Math.min(
        executableQuantity,
        sellLiquidity
      );
  }

  if (
    !Number.isFinite(
      executableQuantity
    ) ||
    executableQuantity <= 0
  ) {
    return;
  }

  const actualCapital =
    executableQuantity *
    buyPrice;

  if (
    actualCapital >
    portfolio.capital
  ) {
    return;
  }

  // ==========================================================
  // PROFITTO
  // ==========================================================

  const profit =
    actualCapital *
    (
      netPercent / 100
    );

  const capitalBefore =
    portfolio.capital;

  portfolio.capital +=
    profit;

  portfolio.totalProfit +=
    profit;

  portfolio.operations++;

  portfolio.totalVolume +=
    actualCapital;

  if (profit >= 0) {
    portfolio.winningOperations++;
  } else {
    portfolio.losingOperations++;
  }

  // ==========================================================
  // REPORT
  // ==========================================================

  console.log("");

  console.log(
    "========================================================"
  );

  console.log(
    "🚨 PAPER ARBITRAGE ESEGUITO"
  );

  console.log(
    "========================================================"
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
    `QUANTITÀ: ` +
    `${executableQuantity.toFixed(8)} ${symbol}`
  );

  console.log(
    `CAPITALE UTILIZZATO: ` +
    `€${actualCapital.toFixed(2)}`
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
    `OPERAZIONI: ` +
    `${portfolio.operations}`
  );

  console.log(
    `LIQUIDITÀ BUY: ` +
    `${Number.isFinite(buyLiquidity) ? buyLiquidity : "N/D"}`
  );

  console.log(
    `LIQUIDITÀ SELL: ` +
    `${Number.isFinite(sellLiquidity) ? sellLiquidity : "N/D"}`
  );

  console.log(
    "MODE: PAPER TRADING"
  );

  console.log(
    "REAL ORDERS: DISABLED"
  );

  console.log(
    "========================================================"
  );

  console.log("");
}

// ============================================================
// STATUS
// ============================================================

function printStatus() {
  console.log("");

  console.log(
    "========================================================"
  );

  console.log(
    `📊 STATUS ${now()}`
  );

  console.log(
    "========================================================"
  );

  for (
    const symbol of ["BTC", "ETH"]
  ) {
    const cb =
      books[symbol].coinbase;

    const okx =
      books[symbol].okx;

    console.log("");

    console.log(
      `📈 ${symbol}`
    );

    if (
      cb.bid &&
      cb.ask &&
      okx.bid &&
      okx.ask
    ) {
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

      console.log(
        `Conferme CB -> OKX: ` +
        `${confirmations[symbol].cbToOkx}/` +
        `${CONFIG.requiredConfirmations}`
      );

      console.log(
        `Conferme OKX -> CB: ` +
        `${confirmations[symbol].okxToCb}/` +
        `${CONFIG.requiredConfirmations}`
      );
    } else {
      console.log(
        "In attesa dei prezzi..."
      );
    }
  }

  console.log("");

  console.log(
    "--------------------------------------------------------"
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
    `✅ Vincenti: ` +
    `${portfolio.winningOperations}`
  );

  console.log(
    `❌ Perdenti: ` +
    `${portfolio.losingOperations}`
  );

  console.log(
    `💱 Volume PAPER: ` +
    `€${portfolio.totalVolume.toFixed(2)}`
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

  console.log("");

  console.log(
    `Soglia netto: ` +
    `${CONFIG.minNetProfitPercent}%`
  );

  console.log(
    `Conferme richieste: ` +
    `${CONFIG.requiredConfirmations}`
  );

  console.log(
    `Trade: ` +
    `${CONFIG.tradePercentOfCapital}% capitale`
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
    `Slippage: ` +
    `${CONFIG.slippagePercent}% per lato`
  );

  console.log(
    "--------------------------------------------------------"
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
// AVVIO
// ============================================================

log(
  "========================================================"
);

log(
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE v2"
);

log(
  "========================================================"
);

log(
  "Modalità: PAPER TRADING"
);

log(
  `Capitale iniziale: €${CONFIG.initialCapital.toFixed(2)}`
);

log(
  `Trade per operazione: ${CONFIG.tradePercentOfCapital}%`
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
  `Slippage per lato: ${CONFIG.slippagePercent}%`
);

log(
  "ORDINI REALI: DISABILITATI"
);

log(
  "========================================================"
);

connectCoinbase();
connectOKX();

setInterval(
  printStatus,
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
