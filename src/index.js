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

  initialCapital: 1000,

  // Importo virtuale utilizzato per ogni operazione
  tradeAmount: 100,

  // Commissione simulata per ogni lato
  feePercent: 0.40,

  // Slippage simulato per ogni lato
  slippagePercent: 0.05,

  // Profitto netto minimo richiesto
  minNetProfitPercent: 0.10,

  // Evita di ripetere la stessa operazione continuamente
  opportunityCooldown: 10000,

  // Connessione
  reconnectDelay: 5000,

  // USD ≈ USDT
  usdToUsdt: 1.0
};

// ============================================================
// STATO PAPER TRADING
// ============================================================

const paper = {
  capital: CONFIG.initialCapital,

  initialCapital: CONFIG.initialCapital,

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
// STATISTICHE CONNESSIONI
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

function money(value) {
  return `€${value.toFixed(2)}`;
}

function percent(value) {
  return `${value.toFixed(4)}%`;
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
    if (!event || !Array.isArray(event.tickers)) {
      continue;
    }

    for (const ticker of event.tickers) {
      if (!ticker) {
        continue;
      }

      const productId = ticker.product_id;

      const symbol = getPairByCoinbaseProduct(productId);

      if (!symbol) {
        continue;
      }

      const bid = Number(ticker.best_bid);
      const ask = Number(ticker.best_ask);

      if (Number.isFinite(bid) && bid > 0) {
        books[symbol].coinbase.bid = bid;
        stats.coinbaseUpdates++;
      }

      if (Number.isFinite(ask) && ask > 0) {
        books[symbol].coinbase.ask = ask;
      }

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

  ws.on("message", raw => {
    try {
      stats.coinbaseMessages++;

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
      stats.okxUpdates++;
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

  ws.on("error", error => {
    log(
      "OKX WebSocket error: " +
      error.message
    );
  });
}

// ============================================================
// CALCOLO ARBITRAGGIO
// ============================================================

function checkArbitrage(symbol) {
  const cb = books[symbol].coinbase;

  const okx = books[symbol].okx;

  if (
    !cb.bid ||
    !cb.ask ||
    !okx.bid ||
    !okx.ask
  ) {
    return;
  }

  // ----------------------------------------------------------
  // CONVERSIONE USD / USDT
  // ----------------------------------------------------------

  const okxBidUSD =
    okx.bid /
    CONFIG.usdToUsdt;

  const okxAskUSD =
    okx.ask /
    CONFIG.usdToUsdt;

  // ----------------------------------------------------------
  // OPPORTUNITÀ 1
  //
  // COMPRA COINBASE
  // VENDE OKX
  // ----------------------------------------------------------

  const gross1 =
    ((okxBidUSD - cb.ask) /
      cb.ask) *
    100;

  // ----------------------------------------------------------
  // OPPORTUNITÀ 2
  //
  // COMPRA OKX
  // VENDE COINBASE
  // ----------------------------------------------------------

  const gross2 =
    ((cb.bid - okxAskUSD) /
      okxAskUSD) *
    100;

  // ----------------------------------------------------------
  // COSTI
  // ----------------------------------------------------------

  const totalFees =
    CONFIG.feePercent * 2;

  const totalSlippage =
    CONFIG.slippagePercent * 2;

  const costs =
    totalFees +
    totalSlippage;

  // ----------------------------------------------------------
  // PROFITTO NETTO
  // ----------------------------------------------------------

  const net1 =
    gross1 - costs;

  const net2 =
    gross2 - costs;

  // ----------------------------------------------------------
  // REPORT LIVE
  // ----------------------------------------------------------

  displayMarketStatus(
    symbol,
    cb,
    okx,
    gross1,
    net1,
    gross2,
    net2
  );

  // ----------------------------------------------------------
  // PAPER TRADE
  // ----------------------------------------------------------

  if (
    net1 >=
    CONFIG.minNetProfitPercent
  ) {
    executePaperTrade(
      symbol,
      "Coinbase",
      cb.ask,
      "OKX",
      okxBidUSD,
      gross1,
      net1
    );
  }

  if (
    net2 >=
    CONFIG.minNetProfitPercent
  ) {
    executePaperTrade(
      symbol,
      "OKX",
      okxAskUSD,
      "Coinbase",
      cb.bid,
      gross2,
      net2
    );
  }
}

// ============================================================
// MARKET STATUS
// ============================================================

function displayMarketStatus(
  symbol,
  cb,
  okx,
  gross1,
  net1,
  gross2,
  net2
) {
  console.log("");

  console.log(
    "----------------------------------------"
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
    `CB -> OKX | Lordo: ${percent(gross1)} | Netto: ${percent(net1)}`
  );

  console.log(
    `OKX -> CB | Lordo: ${percent(gross2)} | Netto: ${percent(net2)}`
  );

  console.log(
    `Capitale PAPER: ${money(paper.capital)}`
  );

  console.log(
    `Profitto totale: ${money(paper.totalProfit)}`
  );

  console.log(
    `Operazioni: ${paper.trades}`
  );

  console.log(
    "----------------------------------------"
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

  // ----------------------------------------------------------
  // COOLDOWN
  // ----------------------------------------------------------

  if (
    currentTime -
      paper.lastTradeTime[symbol] <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  // ----------------------------------------------------------
  // CONTROLLO CAPITALE
  // ----------------------------------------------------------

  if (
    paper.capital <
    CONFIG.tradeAmount
  ) {
    log(
      "⚠️ Capitale PAPER insufficiente."
    );

    return;
  }

  // ----------------------------------------------------------
  // CALCOLO PROFITTO
  // ----------------------------------------------------------

  const profit =
    CONFIG.tradeAmount *
    (netPercent / 100);

  // ----------------------------------------------------------
  // AGGIORNAMENTO PORTAFOGLIO
  // ----------------------------------------------------------

  paper.capital += profit;

  paper.totalProfit += profit;

  paper.trades++;

  paper.volume +=
    CONFIG.tradeAmount;

  if (profit >= 0) {
    paper.winningTrades++;
  } else {
    paper.losingTrades++;
  }

  paper.lastTradeTime[symbol] =
    currentTime;

  // ----------------------------------------------------------
  // REPORT OPERAZIONE
  // ----------------------------------------------------------

  console.log("");

  console.log(
    "========================================"
  );

  console.log(
    "🚨 PAPER TRADE ESEGUITO"
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
    `SPREAD LORDO: ${percent(grossPercent)}`
  );

  console.log(
    `PROFITTO NETTO: ${percent(netPercent)}`
  );

  console.log(
    `IMPORTO: ${money(CONFIG.tradeAmount)}`
  );

  console.log(
    `PROFITTO: ${money(profit)}`
  );

  console.log(
    `CAPITALE PRECEDENTE: ${money(
      paper.capital - profit
    )}`
  );

  console.log(
    `CAPITALE ATTUALE: ${money(
      paper.capital
    )}`
  );

  console.log(
    `PROFITTO TOTALE: ${money(
      paper.totalProfit
    )}`
  );

  console.log(
    `OPERAZIONI: ${paper.trades}`
  );

  console.log(
    "ORDINI REALI: DISABILITATI"
  );

  console.log(
    "========================================"
  );

  console.log("");
}

// ============================================================
// REPORT PERIODICO
// ============================================================

function printPortfolio() {
  const roi =
    paper.initialCapital > 0
      ? (paper.totalProfit /
          paper.initialCapital) *
        100
      : 0;

  console.log("");

  console.log(
    "========================================"
  );

  console.log(
    "💰 PAPER TRADING PORTFOLIO"
  );

  console.log(
    "========================================"
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
    `ROI:               ${percent(roi)}`
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
    `Volume totale:     ${money(
      paper.volume
    )}`
  );

  console.log(
    `Coinbase msg:      ${stats.coinbaseMessages}`
  );

  console.log(
    `Coinbase update:   ${stats.coinbaseUpdates}`
  );

  console.log(
    `OKX msg:           ${stats.okxMessages}`
  );

  console.log(
    `OKX update:        ${stats.okxUpdates}`
  );

  console.log(
    "========================================"
  );

  console.log("");
}

// ============================================================
// AVVIO
// ============================================================

log(
  "========================================"
);

log(
  "🚀 CRYPTO ARBITRAGE BOT"
);

log(
  "========================================"
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
  `Importo per trade: ${money(
    CONFIG.tradeAmount
  )}`
);

log(
  `Fee per lato: ${CONFIG.feePercent}%`
);

log(
  `Slippage per lato: ${CONFIG.slippagePercent}%`
);

log(
  `Profitto netto minimo: ${CONFIG.minNetProfitPercent}%`
);

log(
  "Ordini REALI: DISABILITATI"
);

log(
  "Coppie: BTC / ETH"
);

log(
  "Coinbase: BTC-USD / ETH-USD"
);

log(
  "OKX: BTC-USDT / ETH-USDT"
);

log(
  "========================================"
);

connectCoinbase();

connectOKX();

// Report del portafoglio ogni 60 secondi
setInterval(() => {
  printPortfolio();
}, 60000);
