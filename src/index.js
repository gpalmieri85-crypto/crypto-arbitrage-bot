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
  // CAMBIO USD / USDT
  // ----------------------------------------------------------

  usdToUsdt: 1.0,

  // ----------------------------------------------------------
  // COMMISSIONI TAKER
  //
  // IMPORTANTE:
  // controllare sempre le commissioni effettive del proprio
  // account prima di usare il bot con denaro reale.
  // ----------------------------------------------------------

  fees: {
    coinbaseTakerPercent: 0.60,
    okxTakerPercent: 0.35
  },

  // ----------------------------------------------------------
  // PROFITTO NETTO MINIMO
  // ----------------------------------------------------------

  minNetProfitPercent: 0.05,

  // ----------------------------------------------------------
  // INTERVALLO AGGIORNAMENTO LOG
  // ----------------------------------------------------------

  statusInterval: 10000,

  // ----------------------------------------------------------
  // EVITA SPAM DI OPPORTUNITÀ
  // ----------------------------------------------------------

  opportunityCooldown: 10000,

  // ----------------------------------------------------------
  // PAPER TRADING
  // ----------------------------------------------------------

  paperTrading: true,

  // ----------------------------------------------------------
  // RICONNESSIONE
  // ----------------------------------------------------------

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

function formatPrice(price) {
  if (!Number.isFinite(price)) {
    return "N/D";
  }

  return price.toFixed(2);
}

function formatPercent(value) {
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

    // TICKER
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

    // HEARTBEATS
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
      const text =
        raw.toString();

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

  // ----------------------------------------------------------
  // BID
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // ASK
  // ----------------------------------------------------------

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

      // Ping/pong OKX
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
// CALCOLO PROFITTO NETTO
// ============================================================

function calculateNetProfit(
  grossSpreadPercent,
  buyFeePercent,
  sellFeePercent
) {
  /*
   * Approssimazione prudente:
   *
   * profitto netto =
   * spread lordo - commissione acquisto
   * - commissione vendita
   */

  return (
    grossSpreadPercent -
    buyFeePercent -
    sellFeePercent
  );
}

// ============================================================
// CONTROLLO ARBITRAGGIO
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
  // CONVERSIONE OKX USDT -> USD
  // ----------------------------------------------------------

  const okxBidInUsd =
    okx.bid /
    CONFIG.usdToUsdt;

  const okxAskInUsd =
    okx.ask /
    CONFIG.usdToUsdt;

  // ----------------------------------------------------------
  // OPPORTUNITÀ 1
  //
  // BUY Coinbase
  // SELL OKX
  // ----------------------------------------------------------

  const gross1 =
    (
      (okxBidInUsd - cb.ask) /
      cb.ask
    ) * 100;

  const net1 =
    calculateNetProfit(
      gross1,
      CONFIG.fees.coinbaseTakerPercent,
      CONFIG.fees.okxTakerPercent
    );

  // ----------------------------------------------------------
  // OPPORTUNITÀ 2
  //
  // BUY OKX
  // SELL Coinbase
  // ----------------------------------------------------------

  const gross2 =
    (
      (cb.bid - okxAskInUsd) /
      okxAskInUsd
    ) * 100;

  const net2 =
    calculateNetProfit(
      gross2,
      CONFIG.fees.okxTakerPercent,
      CONFIG.fees.coinbaseTakerPercent
    );

  // ----------------------------------------------------------
  // SE NETTO POSITIVO E SOPRA SOGLIA
  // ----------------------------------------------------------

  if (
    net1 >=
    CONFIG.minNetProfitPercent
  ) {
    reportOpportunity(
      symbol,
      "Coinbase",
      cb.ask,
      "OKX",
      okx.bid,
      gross1,
      net1
    );
  }

  if (
    net2 >=
    CONFIG.minNetProfitPercent
  ) {
    reportOpportunity(
      symbol,
      "OKX",
      okx.ask,
      "Coinbase",
      cb.bid,
      gross2,
      net2
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
  netProfit
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
    "=============================================="
  );

  console.log(
    "🚨 ARBITRAGE OPPORTUNITY"
  );

  console.log(
    "=============================================="
  );

  console.log(
    `PAIR: ${symbol}`
  );

  console.log(
    `BUY:  ${buyExchange} @ ${formatPrice(buyPrice)}`
  );

  console.log(
    `SELL: ${sellExchange} @ ${formatPrice(sellPrice)}`
  );

  console.log(
    `SPREAD LORDO: ${formatPercent(grossSpread)}`
  );

  console.log(
    `FEE ACQUISTO: ${CONFIG.fees[buyExchange === "Coinbase"
      ? "coinbaseTakerPercent"
      : "okxTakerPercent"].toFixed(4)}%`
  );

  console.log(
    `FEE VENDITA: ${CONFIG.fees[sellExchange === "Coinbase"
      ? "coinbaseTakerPercent"
      : "okxTakerPercent"].toFixed(4)}%`
  );

  console.log(
    `PROFITTO NETTO: ${formatPercent(netProfit)}`
  );

  console.log(
    `SOGLIA MINIMA: ${formatPercent(CONFIG.minNetProfitPercent)}`
  );

  console.log(
    `MODE: ${CONFIG.paperTrading
      ? "PAPER TRADING"
      : "REAL TRADING"}`
  );

  console.log(
    "REAL ORDERS: DISABLED"
  );

  console.log(
    "=============================================="
  );

  console.log("");
}

// ============================================================
// STATO PERIODICO
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
      `Coinbase -> BID: ${formatPrice(cb.bid)} | ASK: ${formatPrice(cb.ask)}`
    );

    console.log(
      `OKX      -> BID: ${formatPrice(okx.bid)} | ASK: ${formatPrice(okx.ask)}`
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

      const gross1 =
        (
          (okxBidInUsd - cb.ask) /
          cb.ask
        ) * 100;

      const gross2 =
        (
          (cb.bid - okxAskInUsd) /
          okxAskInUsd
        ) * 100;

      const net1 =
        calculateNetProfit(
          gross1,
          CONFIG.fees.coinbaseTakerPercent,
          CONFIG.fees.okxTakerPercent
        );

      const net2 =
        calculateNetProfit(
          gross2,
          CONFIG.fees.okxTakerPercent,
          CONFIG.fees.coinbaseTakerPercent
        );

      console.log(
        `CB -> OKX | Lordo: ${formatPercent(gross1)} | Netto: ${formatPercent(net1)}`
      );

      console.log(
        `OKX -> CB | Lordo: ${formatPercent(gross2)} | Netto: ${formatPercent(net2)}`
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
    `Opportunità rilevate: ${stats.opportunities}`
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
  "Crypto Arbitrage Scanner avviato"
);

log(
  "============================================================"
);

log(
  "Modalità: PAPER TRADING"
);

log(
  "Capitale reale: €0"
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
  `Commissione Coinbase: ${CONFIG.fees.coinbaseTakerPercent}%`
);

log(
  `Commissione OKX: ${CONFIG.fees.okxTakerPercent}%`
);

log(
  `Profitto netto minimo: ${CONFIG.minNetProfitPercent}%`
);

log(
  "============================================================"
);

// ============================================================
// AVVIO CONNESSIONI
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
