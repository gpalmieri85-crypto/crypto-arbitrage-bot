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

  // Spread minimo per segnalare un'opportunità
  minNetProfitPercent: 0.10,

  // Per il PAPER TRADING assumiamo 1 USD = 1 USDT
  usdToUsdt: 1.0,

  // SICUREZZA: nessun ordine reale
  paperTrading: true,

  // Evita spam di opportunità
  opportunityCooldown: 10000,

  // Riconnessione WebSocket
  reconnectDelay: 5000,

  // Mostra i prezzi ogni 5 secondi
  priceLogInterval: 5000
};

// ============================================================
// ORDER BOOK / PREZZI
// ============================================================

const books = {
  BTC: {
    coinbase: {
      bid: null,
      ask: null,
      lastUpdate: 0
    },
    okx: {
      bid: null,
      ask: null,
      lastUpdate: 0
    }
  },

  ETH: {
    coinbase: {
      bid: null,
      ask: null,
      lastUpdate: 0
    },
    okx: {
      bid: null,
      ask: null,
      lastUpdate: 0
    }
  }
};

// ============================================================
// STATISTICHE
// ============================================================

const stats = {
  coinbaseMessages: 0,
  coinbasePriceUpdates: 0,
  okxMessages: 0,
  okxPriceUpdates: 0
};

const lastOpportunity = {
  BTC: 0,
  ETH: 0
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

// ============================================================
// TROVA COPPIA
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
// COINBASE - AGGIORNAMENTO PREZZI
// ============================================================

function updateCoinbase(data) {
  if (!data || !Array.isArray(data.events)) {
    return;
  }

  for (const event of data.events) {
    if (!event) {
      continue;
    }

    // Coinbase Ticker
    if (Array.isArray(event.tickers)) {
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

        const bestBid = Number(ticker.best_bid);
        const bestAsk = Number(ticker.best_ask);

        let updated = false;

        if (
          Number.isFinite(bestBid) &&
          bestBid > 0
        ) {
          books[symbol].coinbase.bid = bestBid;
          updated = true;
        }

        if (
          Number.isFinite(bestAsk) &&
          bestAsk > 0
        ) {
          books[symbol].coinbase.ask = bestAsk;
          updated = true;
        }

        if (updated) {
          books[symbol].coinbase.lastUpdate =
            Date.now();

          stats.coinbasePriceUpdates++;

          checkArbitrage(symbol);
        }
      }
    }
  }
}

// ============================================================
// COINBASE - CONNESSIONE
// ============================================================

function connectCoinbase() {
  const ws = new WebSocket(
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
    try {
      stats.coinbaseMessages++;

      const text = raw.toString();

      const data = JSON.parse(text);

      updateCoinbase(data);
    } catch (error) {
      log(
        "Errore elaborazione Coinbase: " +
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
// OKX - AGGIORNAMENTO PREZZI
// ============================================================

function updateOKX(data) {
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

  let updated = false;

  // BEST BID
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
      updated = true;
    }
  }

  // BEST ASK
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
      updated = true;
    }
  }

  if (updated) {
    books[symbol].okx.lastUpdate =
      Date.now();

    stats.okxPriceUpdates++;

    checkArbitrage(symbol);
  }
}

// ============================================================
// OKX - CONNESSIONE
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
      stats.okxMessages++;

      const text = raw.toString();

      // Ping OKX
      if (text === "ping") {
        ws.send("pong");
        return;
      }

      const data =
        JSON.parse(text);

      // Conferma subscription
      if (data.event === "subscribe") {
        return;
      }

      // Errore subscription
      if (data.event === "error") {
        log(
          `OKX subscription error ${data.code}: ${data.msg}`
        );

        return;
      }

      updateOKX(data);
    } catch (error) {
      log(
        "Errore elaborazione OKX: " +
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
// ARBITRAGGIO
// ============================================================

function checkArbitrage(symbol) {
  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;

  // Aspettiamo che entrambi gli exchange
  // abbiano bid e ask validi
  if (
    cb.bid === null ||
    cb.ask === null ||
    okx.bid === null ||
    okx.ask === null
  ) {
    return;
  }

  if (
    cb.bid <= 0 ||
    cb.ask <= 0 ||
    okx.bid <= 0 ||
    okx.ask <= 0
  ) {
    return;
  }

  // ==========================================================
  // CONVERSIONE USD -> USDT
  // ==========================================================

  const okxBidInUsd =
    okx.bid /
    CONFIG.usdToUsdt;

  const okxAskInUsd =
    okx.ask /
    CONFIG.usdToUsdt;

  // ==========================================================
  // OPPORTUNITÀ 1
  //
  // COMPRA COINBASE
  // VENDE OKX
  // ==========================================================

  const opportunity1 =
    (
      (
        okxBidInUsd -
        cb.ask
      ) /
      cb.ask
    ) *
    100;

  // ==========================================================
  // OPPORTUNITÀ 2
  //
  // COMPRA OKX
  // VENDE COINBASE
  // ==========================================================

  const opportunity2 =
    (
      (
        cb.bid -
        okxAskInUsd
      ) /
      okxAskInUsd
    ) *
    100;

  // ==========================================================
  // CONTROLLO OPPORTUNITÀ
  // ==========================================================

  if (
    opportunity1 >=
    CONFIG.minNetProfitPercent
  ) {
    reportOpportunity(
      symbol,
      "Coinbase",
      cb.ask,
      "OKX",
      okx.bid,
      opportunity1
    );
  }

  if (
    opportunity2 >=
    CONFIG.minNetProfitPercent
  ) {
    reportOpportunity(
      symbol,
      "OKX",
      okx.ask,
      "Coinbase",
      cb.bid,
      opportunity2
    );
  }
}

// ============================================================
// REPORT ARBITRAGGIO
// ============================================================

function reportOpportunity(
  symbol,
  buyExchange,
  buyPrice,
  sellExchange,
  sellPrice,
  spread
) {
  const currentTime =
    Date.now();

  // Evita spam continuo
  if (
    currentTime -
      lastOpportunity[symbol] <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  lastOpportunity[symbol] =
    currentTime;

  console.log("");

  console.log(
    "========================================"
  );

  console.log(
    "🚨 ARBITRAGE OPPORTUNITY"
  );

  console.log(
    "========================================"
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
    `SPREAD: ${spread.toFixed(4)}%`
  );

  console.log(
    "MODE: PAPER TRADING"
  );

  console.log(
    "REAL ORDERS: DISABLED"
  );

  console.log(
    "========================================"
  );

  console.log("");
}

// ============================================================
// MONITOR PREZZI
// ============================================================

function showPrices() {
  console.log("");

  console.log(
    "------------------------------------------------------------"
  );

  console.log(
    `📊 PREZZI LIVE | ${now()}`
  );

  console.log(
    "------------------------------------------------------------"
  );

  for (const symbol of ["BTC", "ETH"]) {
    const cb =
      books[symbol].coinbase;

    const okx =
      books[symbol].okx;

    console.log(
      `${symbol}`
    );

    console.log(
      `  Coinbase -> BID: ${
        cb.bid !== null
          ? cb.bid.toFixed(2)
          : "ATTESA..."
      } | ASK: ${
        cb.ask !== null
          ? cb.ask.toFixed(2)
          : "ATTESA..."
      }`
    );

    console.log(
      `  OKX      -> BID: ${
        okx.bid !== null
          ? okx.bid.toFixed(2)
          : "ATTESA..."
      } | ASK: ${
        okx.ask !== null
          ? okx.ask.toFixed(2)
          : "ATTESA..."
      }`
    );

    // Calcolo spread attuale
    if (
      cb.ask !== null &&
      okx.bid !== null
    ) {
      const spread1 =
        (
          (
            okx.bid -
            cb.ask
          ) /
          cb.ask
        ) *
        100;

      console.log(
        `  CB -> OKX: ${spread1.toFixed(4)}%`
      );
    }

    if (
      okx.ask !== null &&
      cb.bid !== null
    ) {
      const spread2 =
        (
          (
            cb.bid -
            okx.ask
          ) /
          okx.ask
        ) *
        100;

      console.log(
        `  OKX -> CB: ${spread2.toFixed(4)}%`
      );
    }
  }

  console.log(
    "------------------------------------------------------------"
  );

  console.log(
    `Messaggi Coinbase: ${stats.coinbaseMessages} | Aggiornamenti prezzi: ${stats.coinbasePriceUpdates}`
  );

  console.log(
    `Messaggi OKX: ${stats.okxMessages} | Aggiornamenti prezzi: ${stats.okxPriceUpdates}`
  );

  console.log(
    "------------------------------------------------------------"
  );

  console.log("");
}

// ============================================================
// START
// ============================================================

log(
  "========================================"
);

log(
  "Crypto Arbitrage Scanner avviato"
);

log(
  "========================================"
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
  `Spread minimo: ${CONFIG.minNetProfitPercent}%`
);

log(
  "========================================"
);

// ============================================================
// AVVIO WEBSOCKET
// ============================================================

connectCoinbase();

connectOKX();

// ============================================================
// MONITOR PREZZI OGNI 5 SECONDI
// ============================================================

setInterval(
  showPrices,
  CONFIG.priceLogInterval
);
