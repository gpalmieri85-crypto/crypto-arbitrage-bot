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

  // Per il momento consideriamo USD ≈ USDT.
  // È una semplificazione per il PAPER TRADING.
  usdToUsdt: 1.0,

  // Nessun ordine reale.
  paperTrading: true,

  // Tempo minimo tra due segnalazioni
  opportunityCooldown: 10000,

  // Riconnessione WebSocket
  reconnectDelay: 5000
};

// ============================================================
// ORDER BOOK / PREZZI
// ============================================================

const books = {
  BTC: {
    coinbase: { bid: null, ask: null },
    okx: { bid: null, ask: null }
  },

  ETH: {
    coinbase: { bid: null, ask: null },
    okx: { bid: null, ask: null }
  }
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
    if (!event) continue;

    // Il ticker Coinbase contiene un array "tickers"
    if (!Array.isArray(event.tickers)) {
      continue;
    }

    for (const ticker of event.tickers) {
      if (!ticker) continue;

      const productId = ticker.product_id;

      const symbol = getPairByCoinbaseProduct(productId);

      if (!symbol) {
        continue;
      }

      const bestBid = Number(ticker.best_bid);
      const bestAsk = Number(ticker.best_ask);

      if (Number.isFinite(bestBid) && bestBid > 0) {
        books[symbol].coinbase.bid = bestBid;
      }

      if (Number.isFinite(bestAsk) && bestAsk > 0) {
        books[symbol].coinbase.ask = bestAsk;
      }

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
      const text = raw.toString();

      const data = JSON.parse(text);

      updateCoinbase(data);
    } catch (error) {
      log("Errore Coinbase: " + error.message);
    }
  });

  ws.on("close", () => {
    log("Coinbase disconnesso. Riconnessione...");
    setTimeout(connectCoinbase, CONFIG.reconnectDelay);
  });

  ws.on("error", (error) => {
    log("Coinbase WebSocket error: " + error.message);
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

  const instId = data.arg.instId;

  const symbol = getPairByOKXProduct(instId);

  if (!symbol) {
    return;
  }

  const book = data.data?.[0];

  if (!book) {
    return;
  }

  if (Array.isArray(book.bids) && book.bids.length > 0) {
    const bid = Number(book.bids[0][0]);

    if (Number.isFinite(bid) && bid > 0) {
      books[symbol].okx.bid = bid;
    }
  }

  if (Array.isArray(book.asks) && book.asks.length > 0) {
    const ask = Number(book.asks[0][0]);

    if (Number.isFinite(ask) && ask > 0) {
      books[symbol].okx.ask = ask;
    }
  }

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

  ws.on("message", (raw) => {
    try {
      const text = raw.toString();

      // OKX può utilizzare ping/pong per mantenere
      // la connessione attiva.
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
          `OKX subscription error ${data.code}: ${data.msg}`
        );
        return;
      }

      updateOKX(data);
    } catch (error) {
      log("Errore OKX: " + error.message);
    }
  });

  ws.on("close", () => {
    log("OKX disconnesso. Riconnessione...");
    setTimeout(connectOKX, CONFIG.reconnectDelay);
  });

  ws.on("error", (error) => {
    log("OKX WebSocket error: " + error.message);
  });
}

// ============================================================
// ARBITRAGGIO
// ============================================================

function checkArbitrage(symbol) {
  const cb = books[symbol].coinbase;
  const okx = books[symbol].okx;

  if (!cb.bid || !cb.ask || !okx.bid || !okx.ask) {
    return;
  }

  /*
   * Coinbase quota in USD.
   * OKX quota in USDT.
   *
   * Per il PAPER TRADING iniziale assumiamo:
   *
   * 1 USD = 1 USDT
   *
   * Questo NON rappresenta ancora il profitto reale.
   */

  const okxBidInUsd = okx.bid / CONFIG.usdToUsdt;
  const okxAskInUsd = okx.ask / CONFIG.usdToUsdt;

  // ----------------------------------------------------------
  // OPPORTUNITÀ 1
  // Compra Coinbase
  // Vendi OKX
  // ----------------------------------------------------------

  const opportunity1 =
    ((okxBidInUsd - cb.ask) / cb.ask) * 100;

  // ----------------------------------------------------------
  // OPPORTUNITÀ 2
  // Compra OKX
  // Vendi Coinbase
  // ----------------------------------------------------------

  const opportunity2 =
    ((cb.bid - okxAskInUsd) / okxAskInUsd) * 100;

  if (opportunity1 >= CONFIG.minNetProfitPercent) {
    reportOpportunity(
      symbol,
      "Coinbase",
      cb.ask,
      "OKX",
      okx.bid,
      opportunity1
    );
  }

  if (opportunity2 >= CONFIG.minNetProfitPercent) {
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
// REPORT
// ============================================================

function reportOpportunity(
  symbol,
  buyExchange,
  buyPrice,
  sellExchange,
  sellPrice,
  spread
) {
  const currentTime = Date.now();

  // Evita spam continuo della stessa opportunità
  if (
    currentTime - lastOpportunity[symbol] <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  lastOpportunity[symbol] = currentTime;

  console.log("");
  console.log("========================================");
  console.log("🚨 ARBITRAGE OPPORTUNITY");
  console.log("========================================");
  console.log(`PAIR: ${symbol}`);
  console.log(`BUY:  ${buyExchange} @ ${buyPrice}`);
  console.log(`SELL: ${sellExchange} @ ${sellPrice}`);
  console.log(`SPREAD: ${spread.toFixed(4)}%`);
  console.log("MODE: PAPER TRADING");
  console.log("REAL ORDERS: DISABLED");
  console.log("========================================");
  console.log("");
}

// ============================================================
// START
// ============================================================

log("========================================");
log("Crypto Arbitrage Scanner avviato");
log("========================================");
log("Modalità: PAPER TRADING");
log("Capitale reale: €0");
log("Ordini reali: DISABILITATI");
log("Coppie: BTC, ETH");
log("Coinbase: BTC-USD / ETH-USD");
log("OKX: BTC-USDT / ETH-USDT");
log("========================================");

connectCoinbase();
connectOKX();
