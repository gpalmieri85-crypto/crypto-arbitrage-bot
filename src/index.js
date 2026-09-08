const WebSocket = require("ws");

// ============================================================
// CRYPTO ARBITRAGE PAPER ENGINE
// Coinbase <-> OKX
// PAPER TRADING ONLY
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

  // Percentuale capitale utilizzata per ogni operazione
  tradePercentOfCapital: 20,

  // Profitto netto minimo richiesto
  minNetProfitPercent: 0.10,

  // Numero di conferme consecutive
  requiredConfirmations: 3,

  // Intervallo tra conferme
  confirmationInterval: 1000,

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
  // USD / USDT
  // ==========================================================

  usdToUsdt: 1.0,

  // ==========================================================
  // SICUREZZA
  // ==========================================================

  paperTrading: true,
  realOrdersEnabled: false,

  // ==========================================================
  // QUALITA' PREZZI
  // ==========================================================

  maxPriceAge: 2000,
  maxPriceDesync: 500,

  // ==========================================================
  // TIMING
  // ==========================================================

  opportunityCooldown: 10000,
  reconnectDelay: 5000,

  // Report portafoglio
  statusInterval: 30000,

  // Ping OKX
  okxPingInterval: 20000,

  // Watchdog connessioni
  watchdogInterval: 10000,
  staleConnectionTimeout: 30000
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
    okxToCb: 0,
    lastCbToOkx: 0,
    lastOkxToCb: 0
  },

  ETH: {
    cbToOkx: 0,
    okxToCb: 0,
    lastCbToOkx: 0,
    lastOkxToCb: 0
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

  opportunities: 0,

  profitableOpportunities: 0,

  lastOpportunity: null
};


// ============================================================
// CONNECTION STATE
// ============================================================

let coinbaseWs = null;
let okxWs = null;

let coinbaseConnected = false;
let okxConnected = false;

let lastCoinbaseActivity = 0;
let lastOKXActivity = 0;


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

  return (
    Number.isFinite(value) &&
    value > 0
  );

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
// PREZZI PRONTI
// ============================================================

function pricesReady(symbol) {

  const cb = books[symbol].coinbase;
  const okx = books[symbol].okx;

  return (
    validNumber(cb.bid) &&
    validNumber(cb.ask) &&
    validNumber(okx.bid) &&
    validNumber(okx.ask)
  );

}


// ============================================================
// PREZZI FRESCHI
// ============================================================

function pricesFresh(symbol) {

  const currentTime = Date.now();

  const cbAge =
    currentTime -
    books[symbol].coinbase.timestamp;

  const okxAge =
    currentTime -
    books[symbol].okx.timestamp;

  if (cbAge > CONFIG.maxPriceAge) {

    return false;

  }

  if (okxAge > CONFIG.maxPriceAge) {

    return false;

  }

  const desync =
    Math.abs(
      books[symbol].coinbase.timestamp -
      books[symbol].okx.timestamp
    );

  if (desync > CONFIG.maxPriceDesync) {

    return false;

  }

  return true;

}


// ============================================================
// COINBASE UPDATE
// ============================================================

function updateCoinbase(data) {

  if (!data) {
    return;
  }

  if (!Array.isArray(data.events)) {
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

        const timestamp = Date.now();

        books[symbol]
          .coinbase
          .timestamp = timestamp;

        lastCoinbaseActivity = timestamp;

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

  if (
    coinbaseWs &&
    (
      coinbaseWs.readyState === WebSocket.OPEN ||
      coinbaseWs.readyState === WebSocket.CONNECTING
    )
  ) {

    return;

  }

  log("🔄 Connessione Coinbase...");

  const ws =
    new WebSocket(
      "wss://advanced-trade-ws.coinbase.com"
    );

  coinbaseWs = ws;

  ws.on("open", () => {

    coinbaseConnected = true;

    lastCoinbaseActivity = Date.now();

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

    lastCoinbaseActivity = Date.now();

    stats.coinbaseMessages++;

    try {

      const data =
        JSON.parse(
          raw.toString()
        );

      updateCoinbase(data);

    }

    catch (error) {

      log(
        "❌ Errore Coinbase: " +
        error.message
      );

    }

  });


  ws.on("close", () => {

    coinbaseConnected = false;

    log("🔴 Coinbase disconnesso.");

    if (coinbaseWs === ws) {
      coinbaseWs = null;
    }

    setTimeout(
      connectCoinbase,
      CONFIG.reconnectDelay
    );

  });


  ws.on("error", error => {

    log(
      "❌ Coinbase WebSocket error: " +
      error.message
    );

  });

}


// ============================================================
// OKX UPDATE
// ============================================================

function updateOKX(data) {

  if (!data) {
    return;
  }

  if (!data.arg) {
    return;
  }

  if (
    data.arg.channel !== "bbo-tbt"
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

  let changed = false;


  // BID

  if (
    Array.isArray(book.bids) &&
    book.bids.length > 0
  ) {

    const bid =
      Number(
        book.bids[0][0]
      );

    if (validNumber(bid)) {

      books[symbol].okx.bid = bid;

      changed = true;

    }

  }


  // ASK

  if (
    Array.isArray(book.asks) &&
    book.asks.length > 0
  ) {

    const ask =
      Number(
        book.asks[0][0]
      );

    if (validNumber(ask)) {

      books[symbol].okx.ask = ask;

      changed = true;

    }

  }


  if (changed) {

    const timestamp = Date.now();

    books[symbol]
      .okx
      .timestamp = timestamp;

    lastOKXActivity = timestamp;

    stats.okxUpdates++;

    checkArbitrage(symbol);

  }

}


// ============================================================
// OKX CONNECTION
// ============================================================

function connectOKX() {

  if (
    okxWs &&
    (
      okxWs.readyState === WebSocket.OPEN ||
      okxWs.readyState === WebSocket.CONNECTING
    )
  ) {

    return;

  }

  log("🔄 Connessione OKX...");

  const ws =
    new WebSocket(
      "wss://ws.okx.com:8443/ws/v5/public"
    );

  okxWs = ws;

  let pingTimer = null;


  ws.on("open", () => {

    okxConnected = true;

    lastOKXActivity = Date.now();

    log("🟢 OKX WebSocket CONNECTED");

    ws.send(
      JSON.stringify({
        op: "subscribe",
        args: [
          {
            channel: "bbo-tbt",
            instId: CONFIG.pairs.BTC.okx
          },
          {
            channel: "bbo-tbt",
            instId: CONFIG.pairs.ETH.okx
          }
        ]
      })
    );

    log("🟢 OKX subscriptions ATTIVE");


    pingTimer =
      setInterval(() => {

        if (
          ws.readyState ===
          WebSocket.OPEN
        ) {

          ws.send("ping");

        }

      }, CONFIG.okxPingInterval);

  });


  ws.on("message", raw => {

    lastOKXActivity = Date.now();

    stats.okxMessages++;

    try {

      const text =
        raw.toString();

      if (text === "ping") {

        if (
          ws.readyState ===
          WebSocket.OPEN
        ) {

          ws.send("pong");

        }

        return;

      }


      if (text === "pong") {

        return;

      }


      const data =
        JSON.parse(text);


      if (
        data.event === "subscribe"
      ) {

        return;

      }


      if (
        data.event === "error"
      ) {

        log(
          `❌ OKX error ${data.code}: ${data.msg}`
        );

        return;

      }


      updateOKX(data);

    }

    catch (error) {

      log(
        "❌ Errore OKX: " +
        error.message
      );

    }

  });


  ws.on("close", () => {

    okxConnected = false;

    if (pingTimer) {

      clearInterval(
        pingTimer
      );

    }

    log("🔴 OKX disconnesso.");

    if (okxWs === ws) {
      okxWs = null;
    }

    setTimeout(
      connectOKX,
      CONFIG.reconnectDelay
    );

  });


  ws.on("error", error => {

    log(
      "❌ OKX WebSocket error: " +
      error.message
    );

  });

}


// ============================================================
// CALCOLO ARBITRAGGIO
// ============================================================


// BUY COINBASE
// SELL OKX

function calculateCBtoOKX(cb, okx) {

  const okxBidUSD =
    okx.bid /
    CONFIG.usdToUsdt;


  const effectiveBuy =
    cb.ask *
    (
      1 +
      CONFIG.coinbaseSlippagePercent / 100
    );


  const totalBuy =
    effectiveBuy *
    (
      1 +
      CONFIG.coinbaseFeePercent / 100
    );


  const effectiveSell =
    okxBidUSD *
    (
      1 -
      CONFIG.okxSlippagePercent / 100
    );


  const totalSell =
    effectiveSell *
    (
      1 -
      CONFIG.okxFeePercent / 100
    );


  const gross =
    (
      (
        okxBidUSD -
        cb.ask
      ) /
      cb.ask
    ) *
    100;


  const net =
    (
      (
        totalSell -
        totalBuy
      ) /
      totalBuy
    ) *
    100;


  return {

    gross,

    net,

    buyPrice: totalBuy,

    sellPrice: totalSell

  };

}


// BUY OKX
// SELL COINBASE

function calculateOKXtoCB(cb, okx) {

  const okxAskUSD =
    okx.ask /
    CONFIG.usdToUsdt;


  const effectiveBuy =
    okxAskUSD *
    (
      1 +
      CONFIG.okxSlippagePercent / 100
    );


  const totalBuy =
    effectiveBuy *
    (
      1 +
      CONFIG.okxFeePercent / 100
    );


  const effectiveSell =
    cb.bid *
    (
      1 -
      CONFIG.coinbaseSlippagePercent / 100
    );


  const totalSell =
    effectiveSell *
    (
      1 -
      CONFIG.coinbaseFeePercent / 100
    );


  const gross =
    (
      (
        cb.bid -
        okxAskUSD
      ) /
      okxAskUSD
    ) *
    100;


  const net =
    (
      (
        totalSell -
        totalBuy
      ) /
      totalBuy
    ) *
    100;


  return {

    gross,

    net,

    buyPrice: totalBuy,

    sellPrice: totalSell

  };

}


// ============================================================
// BREAK-EVEN
// ============================================================

function calculateBreakEvenBuyCoinbaseSellOKX() {

  const buyFactor =
    (
      1 +
      CONFIG.coinbaseSlippagePercent / 100
    ) *
    (
      1 +
      CONFIG.coinbaseFeePercent / 100
    );


  const sellFactor =
    (
      1 -
      CONFIG.okxSlippagePercent / 100
    ) *
    (
      1 -
      CONFIG.okxFeePercent / 100
    );


  return (
    (
      buyFactor /
      sellFactor
    ) -
    1
  ) * 100;

}


function calculateBreakEvenBuyOKXSellCoinbase() {

  const buyFactor =
    (
      1 +
      CONFIG.okxSlippagePercent / 100
    ) *
    (
      1 +
      CONFIG.okxFeePercent / 100
    );


  const sellFactor =
    (
      1 -
      CONFIG.coinbaseSlippagePercent / 100
    ) *
    (
      1 -
      CONFIG.coinbaseFeePercent / 100
    );


  return (
    (
      buyFactor /
      sellFactor
    ) -
    1
  ) * 100;

}


// ============================================================
// CONFERME
// ============================================================

function updateConfirmation(
  symbol,
  direction,
  profitable
) {

  const confirmation =
    confirmations[symbol];

  const currentTime =
    Date.now();


  if (!profitable) {

    if (direction === "CB_OKX") {

      confirmation.cbToOkx = 0;
      confirmation.lastCbToOkx = 0;

    }

    else {

      confirmation.okxToCb = 0;
      confirmation.lastOkxToCb = 0;

    }

    return;

  }


  if (direction === "CB_OKX") {

    if (
      confirmation.lastCbToOkx === 0 ||
      (
        currentTime -
        confirmation.lastCbToOkx
      ) >=
      CONFIG.confirmationInterval
    ) {

      confirmation.cbToOkx++;

      confirmation.lastCbToOkx =
        currentTime;

    }

  }


  else {

    if (
      confirmation.lastOkxToCb === 0 ||
      (
        currentTime -
        confirmation.lastOkxToCb
      ) >=
      CONFIG.confirmationInterval
    ) {

      confirmation.okxToCb++;

      confirmation.lastOkxToCb =
        currentTime;

    }

  }

}


// ============================================================
// DISPLAY
// ============================================================

function displayStatus(
  symbol,
  cb,
  okx,
  result1,
  result2,
  breakEven1,
  breakEven2
) {

  console.log("");

  console.log(
    "------------------------------------------------------------"
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
    `CB -> OKX | Lordo: ${pct(result1.gross)} | Netto: ${pct(result1.net)}`
  );


  console.log(
    `Manca alla redditività CB -> OKX: ${pct(
      Math.max(
        0,
        breakEven1 - result1.gross
      )
    )}`
  );


  console.log(
    `OKX -> CB | Lordo: ${pct(result2.gross)} | Netto: ${pct(result2.net)}`
  );


  console.log(
    `Manca alla redditività OKX -> CB: ${pct(
      Math.max(
        0,
        breakEven2 - result2.gross
      )
    )}`
  );


  console.log(
    `Break-even CB -> OKX: ${pct(breakEven1)}`
  );


  console.log(
    `Break-even OKX -> CB: ${pct(breakEven2)}`
  );


  console.log(
    `Conferma CB -> OKX: ${
      confirmations[symbol].cbToOkx
    }/${CONFIG.requiredConfirmations}`
  );


  console.log(
    `Conferma OKX -> CB: ${
      confirmations[symbol].okxToCb
    }/${CONFIG.requiredConfirmations}`
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
    "------------------------------------------------------------"
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

  // ----------------------------------------------------------
  // SICUREZZA
  // ----------------------------------------------------------

  if (!CONFIG.paperTrading) {

    return false;

  }


  if (CONFIG.realOrdersEnabled) {

    log(
      "❌ BLOCCO SICUREZZA: ordini reali disabilitati."
    );

    return false;

  }


  if (
    !Number.isFinite(netPercent) ||
    netPercent <
    CONFIG.minNetProfitPercent
  ) {

    return false;

  }


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

    return false;

  }


  // ----------------------------------------------------------
  // CAPITALE
  // ----------------------------------------------------------

  const tradeAmount =
    paper.capital *
    (
      CONFIG.tradePercentOfCapital /
      100
    );


  if (
    tradeAmount <= 0 ||
    tradeAmount > paper.capital
  ) {

    log(
      "⚠️ Capitale PAPER insufficiente"
    );

    return false;

  }


  // ----------------------------------------------------------
  // PROFITTO
  // ----------------------------------------------------------

  const profit =
    tradeAmount *
    (
      netPercent /
      100
    );


  if (profit <= 0) {

    return false;

  }


  const previousCapital =
    paper.capital;


  paper.capital +=
    profit;

  paper.totalProfit +=
    profit;

  paper.trades++;

  paper.volume +=
    tradeAmount;


  if (profit > 0) {

    paper.winningTrades++;

  }

  else {

    paper.losingTrades++;

  }


  paper.lastTradeTime[symbol] =
    currentTime;


  stats.lastOpportunity = {

    symbol,

    buyExchange,

    sellExchange,

    grossPercent,

    netPercent,

    profit,

    timestamp:
      currentTime

  };


  stats.profitableOpportunities++;


  // ----------------------------------------------------------
  // REPORT TRADE
  // ----------------------------------------------------------

  console.log("");

  console.log(
    "============================================================"
  );

  console.log(
    "🚨🚨🚨 PAPER TRADE ESEGUITO 🚨🚨🚨"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `PAIR: ${symbol}`
  );

  console.log(
    `BUY:  ${buyExchange} @ ${Number(buyPrice).toFixed(2)}`
  );

  console.log(
    `SELL: ${sellExchange} @ ${Number(sellPrice).toFixed(2)}`
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
    "============================================================"
  );

  console.log("");

  return true;

}


// ============================================================
// VERIFICA ARBITRAGGIO
// ============================================================

function checkArbitrage(symbol) {

  stats.checks++;


  if (!pricesReady(symbol)) {

    return;

  }


  if (!pricesFresh(symbol)) {

    return;

  }


  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;


  const result1 =
    calculateCBtoOKX(
      cb,
      okx
    );


  const result2 =
    calculateOKXtoCB(
      cb,
      okx
    );


  const breakEven1 =
    calculateBreakEvenBuyCoinbaseSellOKX();


  const breakEven2 =
    calculateBreakEvenBuyOKXSellCoinbase();


  stats.opportunities++;


  // ----------------------------------------------------------
  // PROFITTO NETTO REALE SIMULATO
  // ----------------------------------------------------------

  const profitable1 =
    result1.net >=
    CONFIG.minNetProfitPercent;


  const profitable2 =
    result2.net >=
    CONFIG.minNetProfitPercent;


  // ----------------------------------------------------------
  // CONFERME
  // ----------------------------------------------------------

  updateConfirmation(
    symbol,
    "CB_OKX",
    profitable1
  );


  updateConfirmation(
    symbol,
    "OKX_CB",
    profitable2
  );


  // ----------------------------------------------------------
  // DISPLAY
  // ----------------------------------------------------------

  displayStatus(
    symbol,
    cb,
    okx,
    result1,
    result2,
    breakEven1,
    breakEven2
  );


  // ----------------------------------------------------------
  // PAPER TRADE CB -> OKX
  // ----------------------------------------------------------

  if (
    profitable1 &&
    confirmations[symbol].cbToOkx >=
    CONFIG.requiredConfirmations
  ) {

    const executed =
      executePaperTrade(
        symbol,
        "Coinbase",
        cb.ask,
        "OKX",
        okx.bid,
        result1.gross,
        result1.net
      );


    // IMPORTANTE:
    // reset solo se il trade è stato realmente eseguito

    if (executed) {

      confirmations[symbol].cbToOkx = 0;

      confirmations[symbol].lastCbToOkx = 0;

    }

  }


  // ----------------------------------------------------------
  // PAPER TRADE OKX -> CB
  // ----------------------------------------------------------

  if (
    profitable2 &&
    confirmations[symbol].okxToCb >=
    CONFIG.requiredConfirmations
  ) {

    const executed =
      executePaperTrade(
        symbol,
        "OKX",
        okx.ask,
        "Coinbase",
        cb.bid,
        result2.gross,
        result2.net
      );


    if (executed) {

      confirmations[symbol].okxToCb = 0;

      confirmations[symbol].lastOkxToCb = 0;

    }

  }

}


// ============================================================
// REPORT PORTAFOGLIO
// ============================================================

function printPortfolio() {

  const roi =
    (
      paper.totalProfit /
      paper.initialCapital
    ) *
    100;


  console.log("");

  console.log(
    "============================================================"
  );

  console.log(
    "💰 PAPER TRADING REPORT"
  );

  console.log(
    "============================================================"
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
    `Controlli mercato: ${stats.checks}`
  );


  console.log(
    `Opportunità viste: ${stats.opportunities}`
  );


  console.log(
    `Opportunità profittevoli: ${
      stats.profitableOpportunities
    }`
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
    `Break-even CB -> OKX: ${
      calculateBreakEvenBuyCoinbaseSellOKX()
        .toFixed(4)
    }%`
  );


  console.log(
    `Break-even OKX -> CB: ${
      calculateBreakEvenBuyOKXSellCoinbase()
        .toFixed(4)
    }%`
  );


  console.log("");

  console.log(
    `Coinbase: ${
      coinbaseConnected
        ? "🟢 CONNESSO"
        : "🔴 DISCONNESSO"
    }`
  );


  console.log(
    `OKX: ${
      okxConnected
        ? "🟢 CONNESSO"
        : "🔴 DISCONNESSO"
    }`
  );


  console.log("");

  console.log(
    "🔒 ORDINI REALI: DISABILITATI"
  );


  console.log(
    "============================================================"
  );

}


// ============================================================
// WATCHDOG
// ============================================================

setInterval(() => {

  const currentTime =
    Date.now();


  // ----------------------------------------------------------
  // COINBASE
  // ----------------------------------------------------------

  if (
    coinbaseConnected &&
    lastCoinbaseActivity > 0 &&
    (
      currentTime -
      lastCoinbaseActivity
    ) >
    CONFIG.staleConnectionTimeout
  ) {

    log(
      `⚠️ Coinbase inattivo da ${
        currentTime -
        lastCoinbaseActivity
      } ms. Riconnessione...`
    );


    coinbaseConnected = false;


    if (coinbaseWs) {

      try {

        coinbaseWs.terminate();

      }

      catch (_) {}

      coinbaseWs = null;

    }

  }


  // ----------------------------------------------------------
  // OKX
  // ----------------------------------------------------------

  if (
    okxConnected &&
    lastOKXActivity > 0 &&
    (
      currentTime -
      lastOKXActivity
    ) >
    CONFIG.staleConnectionTimeout
  ) {

    log(
      `⚠️ OKX inattivo da ${
        currentTime -
        lastOKXActivity
      } ms. Riconnessione...`
    );


    okxConnected = false;


    if (okxWs) {

      try {

        okxWs.terminate();

      }

      catch (_) {}

      okxWs = null;

    }

  }


  // ----------------------------------------------------------
  // SICUREZZA EXTRA
  // ----------------------------------------------------------

  if (!coinbaseConnected) {

    connectCoinbase();

  }


  if (!okxConnected) {

    connectOKX();

  }

}, CONFIG.watchdogInterval);


// ============================================================
// START
// ============================================================

log(
  "============================================================"
);

log(
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE"
);

log(
  "============================================================"
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
  `Intervallo conferme: ${CONFIG.confirmationInterval} ms`
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
  `Break-even CB -> OKX: ${
    calculateBreakEvenBuyCoinbaseSellOKX()
      .toFixed(4)
  }%`
);

log(
  `Break-even OKX -> CB: ${
    calculateBreakEvenBuyOKXSellCoinbase()
      .toFixed(4)
  }%`
);

log(
  "🔒 ORDINI REALI: DISABILITATI"
);

log(
  "============================================================"
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
