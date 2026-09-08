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

  paperTrading: true,

  simulatedCapitalEUR: 1000,

  // Per ora assumiamo USD ≈ USDT ≈ EUR.
  // In seguito possiamo collegare i cambi reali.
  usdToUsdt: 1.0,
  eurToUsd: 1.0,

  // ==========================================================
  // COMMISSIONI TAKER
  // ==========================================================

  fees: {
    coinbaseTakerPercent: 0.60,
    okxTakerPercent: 0.35
  },

  // ==========================================================
  // SOGLIA PROFITTO
  // ==========================================================

  minNetProfitEUR: 0.01,

  // ==========================================================
  // STATUS
  // ==========================================================

  statusInterval: 10000,

  opportunityCooldown: 10000,

  reconnectDelay: 5000
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
// STATISTICHE
// ============================================================

const stats = {
  coinbaseMessages: 0,
  okxMessages: 0,

  coinbaseUpdates: 0,
  okxUpdates: 0,

  opportunities: 0,

  lastOpportunity: {
    BTC: 0,
    ETH: 0
  }
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
  if (!Number.isFinite(value)) {
    return "N/D";
  }

  return `€${value.toFixed(2)}`;
}

function price(value) {
  if (!Number.isFinite(value)) {
    return "N/D";
  }

  return value.toFixed(2);
}

function percent(value) {
  if (!Number.isFinite(value)) {
    return "N/D";
  }

  return `${value.toFixed(4)}%`;
}

// ============================================================
// IDENTIFICAZIONE COPPIE
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

      stats.coinbaseUpdates++;

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

      checkArbitrage(symbol);
    }
  }
}

// ============================================================
// CONNESSIONE COINBASE
// ============================================================

function connectCoinbase() {
  const ws =
    new WebSocket(
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
    stats.coinbaseMessages++;

    try {
      const data =
        JSON.parse(raw.toString());

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
  if (!data || !data.arg) {
    return;
  }

  if (data.arg.channel !== "books5") {
    return;
  }

  const instId =
    data.arg.instId;

  const symbol =
    getPairByOKXProduct(instId);

  if (!symbol) {
    return;
  }

  const book =
    data.data?.[0];

  if (!book) {
    return;
  }

  stats.okxUpdates++;

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

  checkArbitrage(symbol);
}

// ============================================================
// CONNESSIONE OKX
// ============================================================

function connectOKX() {
  const ws =
    new WebSocket(
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

    log("OKX subscriptions ATTIVE");
  });

  ws.on("message", (raw) => {
    stats.okxMessages++;

    try {
      const text =
        raw.toString();

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
          `OKX subscription error ${data.code}: ${data.msg}`
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

  ws.on("error", (error) => {
    log(
      "OKX WebSocket error: " +
      error.message
    );
  });
}

// ============================================================
// SIMULAZIONE OPERAZIONE
// ============================================================

function simulateTrade(
  buyPrice,
  sellPrice,
  buyFeePercent,
  sellFeePercent
) {
  const capitalEUR =
    CONFIG.simulatedCapitalEUR;

  // Capitale convertito in USD
  const capitalUSD =
    capitalEUR *
    CONFIG.eurToUsd;

  // Commissione acquisto
  const buyFee =
    buyFeePercent / 100;

  // Commissione vendita
  const sellFee =
    sellFeePercent / 100;

  // ==========================================================
  // ACQUISTO
  // ==========================================================

  const capitalAvailable =
    capitalUSD /
    (1 + buyFee);

  const buyCommission =
    capitalAvailable *
    buyFee;

  const quantity =
    capitalAvailable /
    buyPrice;

  const totalSpentUSD =
    capitalAvailable +
    buyCommission;

  // ==========================================================
  // VENDITA
  // ==========================================================

  const grossSellValueUSD =
    quantity *
    sellPrice;

  const sellCommission =
    grossSellValueUSD *
    sellFee;

  const netSellValueUSD =
    grossSellValueUSD -
    sellCommission;

  // ==========================================================
  // PROFITTO
  // ==========================================================

  const profitUSD =
    netSellValueUSD -
    totalSpentUSD;

  const profitEUR =
    profitUSD /
    CONFIG.eurToUsd;

  const profitPercent =
    (
      profitEUR /
      capitalEUR
    ) * 100;

  return {
    capitalEUR,

    quantity,

    buyCommissionUSD:
      buyCommission,

    sellCommissionUSD:
      sellCommission,

    totalFeesUSD:
      buyCommission +
      sellCommission,

    totalSpentUSD,

    grossSellValueUSD,

    netSellValueUSD,

    profitUSD,

    profitEUR,

    profitPercent
  };
}

// ============================================================
// BREAK EVEN
// ============================================================

function calculateBreakEvenSpread(
  buyFeePercent,
  sellFeePercent
) {
  const buyFee =
    buyFeePercent / 100;

  const sellFee =
    sellFeePercent / 100;

  /*
   * Per andare in pari:

   * prezzo vendita * (1 - fee vendita)
   * =
   * prezzo acquisto * (1 + fee acquisto)

   */

  const requiredRatio =
    (1 + buyFee) /
    (1 - sellFee);

  return (
    (requiredRatio - 1) *
    100
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

  const okxBidInUsd =
    okx.bid /
    CONFIG.usdToUsdt;

  const okxAskInUsd =
    okx.ask /
    CONFIG.usdToUsdt;

  // ==========================================================
  // COINBASE -> OKX
  // ==========================================================

  const gross1 =
    (
      (okxBidInUsd - cb.ask) /
      cb.ask
    ) * 100;

  const trade1 =
    simulateTrade(
      cb.ask,
      okxBidInUsd,
      CONFIG.fees.coinbaseTakerPercent,
      CONFIG.fees.okxTakerPercent
    );

  // ==========================================================
  // OKX -> COINBASE
  // ==========================================================

  const gross2 =
    (
      (cb.bid - okxAskInUsd) /
      okxAskInUsd
    ) * 100;

  const trade2 =
    simulateTrade(
      okxAskInUsd,
      cb.bid,
      CONFIG.fees.okxTakerPercent,
      CONFIG.fees.coinbaseTakerPercent
    );

  // ==========================================================
  // OPPORTUNITÀ
  // ==========================================================

  if (
    trade1.profitEUR >=
    CONFIG.minNetProfitEUR
  ) {
    reportOpportunity(
      symbol,
      "Coinbase",
      cb.ask,
      "OKX",
      okx.bid,
      gross1,
      trade1
    );
  }

  if (
    trade2.profitEUR >=
    CONFIG.minNetProfitEUR
  ) {
    reportOpportunity(
      symbol,
      "OKX",
      okx.ask,
      "Coinbase",
      cb.bid,
      gross2,
      trade2
    );
  }
}

// ============================================================
// REPORT OPPORTUNITÀ
// ============================================================

function reportOpportunity(
  symbol,
  buyExchange,
  buyPrice,
  sellExchange,
  sellPrice,
  grossSpread,
  trade
) {
  const currentTime =
    Date.now();

  if (
    currentTime -
    stats.lastOpportunity[symbol] <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  stats.lastOpportunity[symbol] =
    currentTime;

  stats.opportunities++;

  console.log("");

  console.log(
    "============================================================"
  );

  console.log(
    "🚨 OPPORTUNITÀ DI ARBITRAGGIO"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `PAIR: ${symbol}`
  );

  console.log(
    `CAPITALE SIMULATO: ${money(CONFIG.simulatedCapitalEUR)}`
  );

  console.log("");

  console.log(
    `BUY:  ${buyExchange} @ ${price(buyPrice)}`
  );

  console.log(
    `SELL: ${sellExchange} @ ${price(sellPrice)}`
  );

  console.log("");

  console.log(
    `SPREAD LORDO: ${percent(grossSpread)}`
  );

  console.log(
    `QUANTITÀ: ${trade.quantity.toFixed(8)} ${symbol}`
  );

  console.log("");

  console.log(
    `COMMISSIONI TOTALI: ${money(
      trade.totalFeesUSD /
      CONFIG.eurToUsd
    )}`
  );

  console.log(
    `RICAVO NETTO: ${money(
      trade.netSellValueUSD /
      CONFIG.eurToUsd
    )}`
  );

  console.log(
    `PROFITTO NETTO: ${money(trade.profitEUR)}`
  );

  console.log(
    `ROI NETTO: ${percent(trade.profitPercent)}`
  );

  console.log("");

  console.log(
    "MODE: PAPER TRADING"
  );

  console.log(
    "REAL ORDERS: DISABLED"
  );

  console.log(
    "============================================================"
  );

  console.log("");
}

// ============================================================
// STATUS
// ============================================================

function printStatus() {
  console.log("");

  console.log(
    "------------------------------------------------------------"
  );

  console.log(
    `STATUS ${now()}`
  );

  console.log(
    `CAPITALE PAPER: ${money(CONFIG.simulatedCapitalEUR)}`
  );

  console.log(
    "------------------------------------------------------------"
  );

  for (const symbol of ["BTC", "ETH"]) {
    const cb =
      books[symbol].coinbase;

    const okx =
      books[symbol].okx;

    console.log("");

    console.log(symbol);

    console.log(
      `Coinbase -> BID: ${price(cb.bid)} | ASK: ${price(cb.ask)}`
    );

    console.log(
      `OKX      -> BID: ${price(okx.bid)} | ASK: ${price(okx.ask)}`
    );

    if (
      cb.bid &&
      cb.ask &&
      okx.bid &&
      okx.ask
    ) {
      const okxBidInUsd =
        okx.bid /
        CONFIG.usdToUsdt;

      const okxAskInUsd =
        okx.ask /
        CONFIG.usdToUsdt;

      // ======================================================
      // CB -> OKX
      // ======================================================

      const gross1 =
        (
          (okxBidInUsd - cb.ask) /
          cb.ask
        ) * 100;

      const trade1 =
        simulateTrade(
          cb.ask,
          okxBidInUsd,
          CONFIG.fees.coinbaseTakerPercent,
          CONFIG.fees.okxTakerPercent
        );

      // ======================================================
      // OKX -> CB
      // ======================================================

      const gross2 =
        (
          (cb.bid - okxAskInUsd) /
          okxAskInUsd
        ) * 100;

      const trade2 =
        simulateTrade(
          okxAskInUsd,
          cb.bid,
          CONFIG.fees.okxTakerPercent,
          CONFIG.fees.coinbaseTakerPercent
        );

      console.log("");

      console.log(
        `CB -> OKX | Lordo: ${percent(gross1)} | Netto: ${money(trade1.profitEUR)} | ROI: ${percent(trade1.profitPercent)}`
      );

      console.log(
        `OKX -> CB | Lordo: ${percent(gross2)} | Netto: ${money(trade2.profitEUR)} | ROI: ${percent(trade2.profitPercent)}`
      );

      const breakEven1 =
        calculateBreakEvenSpread(
          CONFIG.fees.coinbaseTakerPercent,
          CONFIG.fees.okxTakerPercent
        );

      const breakEven2 =
        calculateBreakEvenSpread(
          CONFIG.fees.okxTakerPercent,
          CONFIG.fees.coinbaseTakerPercent
        );

      console.log(
        `Break-even CB -> OKX: ${percent(breakEven1)}`
      );

      console.log(
        `Break-even OKX -> CB: ${percent(breakEven2)}`
      );
    } else {
      console.log(
        "In attesa dei prezzi..."
      );
    }
  }

  console.log("");

  console.log(
    `Coinbase messaggi: ${stats.coinbaseMessages} | Aggiornamenti: ${stats.coinbaseUpdates}`
  );

  console.log(
    `OKX messaggi: ${stats.okxMessages} | Aggiornamenti: ${stats.okxUpdates}`
  );

  console.log(
    `Opportunità profittevoli: ${stats.opportunities}`
  );

  console.log(
    "------------------------------------------------------------"
  );
}

// ============================================================
// START
// ============================================================

log(
  "============================================================"
);

log(
  "CRYPTO ARBITRAGE SCANNER"
);

log(
  "============================================================"
);

log(
  "Modalità: PAPER TRADING"
);

log(
  `Capitale simulato: ${money(CONFIG.simulatedCapitalEUR)}`
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
  `Fee Coinbase Taker: ${CONFIG.fees.coinbaseTakerPercent}%`
);

log(
  `Fee OKX Taker: ${CONFIG.fees.okxTakerPercent}%`
);

log(
  `Profitto minimo: ${money(CONFIG.minNetProfitEUR)}`
);

log(
  `Break-even stimato: ${percent(
    calculateBreakEvenSpread(
      CONFIG.fees.coinbaseTakerPercent,
      CONFIG.fees.okxTakerPercent
    )
  )}`
);

log(
  "============================================================"
);

// ============================================================
// AVVIO
// ============================================================

connectCoinbase();

connectOKX();

// ============================================================
// STATUS OGNI 10 SECONDI
// ============================================================

setInterval(
  printStatus,
  CONFIG.statusInterval
);
