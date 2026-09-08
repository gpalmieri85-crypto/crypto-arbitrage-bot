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

  // Percentuale del capitale utilizzata per ogni trade
  tradePercentOfCapital: 20,

  // Profitto NETTO minimo richiesto
  minNetProfitPercent: 0.10,

  // Numero di conferme consecutive necessarie
  requiredConfirmations: 3,

  // Intervallo minimo tra conferme
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
  // CONVERSIONE
  // ==========================================================

  // Per il PAPER TRADING assumiamo 1 USD = 1 USDT
  usdToUsdt: 1.0,

  // ==========================================================
  // SICUREZZA DATI
  // ==========================================================

  maxPriceAge: 2000,

  // ==========================================================
  // TIMING
  // ==========================================================

  opportunityCooldown: 10000,

  reconnectDelay: 5000,

  statusInterval: 30000,

  okxPingInterval: 20000
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
// MARKET BOOK
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

  opportunities: 0,

  profitableOpportunities: 0,

  lastOpportunity: null
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
  return `€${Number(value).toFixed(2)}`;
}

function pct(value) {
  return `${Number(value).toFixed(4)}%`;
}

function validNumber(value) {
  return Number.isFinite(value) && value > 0;
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

  const nowMs = Date.now();

  const cbAge =
    nowMs - books[symbol].coinbase.timestamp;

  const okxAge =
    nowMs - books[symbol].okx.timestamp;

  if (cbAge > CONFIG.maxPriceAge) {
    return false;
  }

  if (okxAge > CONFIG.maxPriceAge) {
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

        books[symbol]
          .coinbase
          .bid = bid;

        changed = true;
      }

      if (validNumber(ask)) {

        books[symbol]
          .coinbase
          .ask = ask;

        changed = true;
      }

      if (changed) {

        books[symbol]
          .coinbase
          .timestamp = Date.now();

        stats.coinbaseUpdates++;

        checkArbitrage(symbol);
      }
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

    log(
      "🟢 Coinbase WebSocket CONNECTED"
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
      "🟢 Coinbase subscriptions ATTIVE"
    );
  });

  ws.on("message", raw => {

    try {

      stats.coinbaseMessages++;

      const data =
        JSON.parse(
          raw.toString()
        );

      updateCoinbase(data);

    } catch (error) {

      log(
        "❌ Errore Coinbase: " +
        error.message
      );
    }
  });

  ws.on("close", () => {

    log(
      "🔴 Coinbase disconnesso"
    );

    log(
      "🔄 Riconnessione Coinbase..."
    );

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

  // ----------------------------------------------------------
  // BID
  // ----------------------------------------------------------

  if (
    Array.isArray(book.bids) &&
    book.bids.length > 0
  ) {

    const bid =
      Number(book.bids[0][0]);

    if (validNumber(bid)) {

      books[symbol]
        .okx
        .bid = bid;

      changed = true;
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

    if (validNumber(ask)) {

      books[symbol]
        .okx
        .ask = ask;

      changed = true;
    }
  }

  if (changed) {

    books[symbol]
      .okx
      .timestamp = Date.now();

    stats.okxUpdates++;

    checkArbitrage(symbol);
  }
}

// ============================================================
// CONNESSIONE OKX
// ============================================================

function connectOKX() {

  const ws =
    new WebSocket(
      "wss://ws.okx.com:8443/ws/v5/public"
    );

  let pingTimer = null;

  ws.on("open", () => {

    log(
      "🟢 OKX WebSocket CONNECTED"
    );

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

    log(
      "🟢 OKX subscriptions ATTIVE"
    );

    // --------------------------------------------------------
    // PING
    // --------------------------------------------------------

    pingTimer =
      setInterval(() => {

        if (
          ws.readyState ===
          WebSocket.OPEN
        ) {

          ws.send("ping");
        }

      },
      CONFIG.okxPingInterval
      );
  });

  ws.on("message", raw => {

    try {

      stats.okxMessages++;

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
          `❌ OKX error ${data.code}: ${data.msg}`
        );

        return;
      }

      updateOKX(data);

    } catch (error) {

      log(
        "❌ Errore OKX: " +
        error.message
      );
    }
  });

  ws.on("close", () => {

    if (pingTimer) {

      clearInterval(
        pingTimer
      );

      pingTimer = null;
    }

    log(
      "🔴 OKX disconnesso"
    );

    log(
      "🔄 Riconnessione OKX..."
    );

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
// CALCOLO DIREZIONE 1
//
// COMPRA COINBASE
// VENDE OKX
// ============================================================

function calculateCBtoOKX(cb, okx) {

  const okxBidUSD =
    okx.bid /
    CONFIG.usdToUsdt;

  // Prezzo effettivo di acquisto
  const effectiveBuy =
    cb.ask *
    (
      1 +
      CONFIG.coinbaseSlippagePercent /
      100
    );

  // Costo dopo commissione Coinbase
  const totalBuy =
    effectiveBuy *
    (
      1 +
      CONFIG.coinbaseFeePercent /
      100
    );

  // Prezzo effettivo di vendita
  const effectiveSell =
    okxBidUSD *
    (
      1 -
      CONFIG.okxSlippagePercent /
      100
    );

  // Ricavo dopo commissione OKX
  const totalSell =
    effectiveSell *
    (
      1 -
      CONFIG.okxFeePercent /
      100
    );

  // Spread lordo
  const gross =
    (
      (okxBidUSD - cb.ask) /
      cb.ask
    ) * 100;

  // Profitto netto
  const net =
    (
      (totalSell - totalBuy) /
      totalBuy
    ) * 100;

  return {

    gross,

    net,

    buyPrice: totalBuy,

    sellPrice: totalSell
  };
}

// ============================================================
// CALCOLO DIREZIONE 2
//
// COMPRA OKX
// VENDE COINBASE
// ============================================================

function calculateOKXtoCB(cb, okx) {

  const okxAskUSD =
    okx.ask /
    CONFIG.usdToUsdt;

  // Prezzo effettivo acquisto OKX
  const effectiveBuy =
    okxAskUSD *
    (
      1 +
      CONFIG.okxSlippagePercent /
      100
    );

  // Costo dopo commissione OKX
  const totalBuy =
    effectiveBuy *
    (
      1 +
      CONFIG.okxFeePercent /
      100
    );

  // Prezzo effettivo vendita Coinbase
  const effectiveSell =
    cb.bid *
    (
      1 -
      CONFIG.coinbaseSlippagePercent /
      100
    );

  // Ricavo dopo commissione Coinbase
  const totalSell =
    effectiveSell *
    (
      1 -
      CONFIG.coinbaseFeePercent /
      100
    );

  // Spread lordo
  const gross =
    (
      (cb.bid - okxAskUSD) /
      okxAskUSD
    ) * 100;

  // Profitto netto
  const net =
    (
      (totalSell - totalBuy) /
      totalBuy
    ) * 100;

  return {

    gross,

    net,

    buyPrice: totalBuy,

    sellPrice: totalSell
  };
}

// ============================================================
// BREAK EVEN
// ============================================================

function calculateBreakEvenBuyCoinbaseSellOKX() {

  const buyFactor =
    (
      1 +
      CONFIG.coinbaseSlippagePercent /
      100
    ) *
    (
      1 +
      CONFIG.coinbaseFeePercent /
      100
    );

  const sellFactor =
    (
      1 -
      CONFIG.okxSlippagePercent /
      100
    ) *
    (
      1 -
      CONFIG.okxFeePercent /
      100
    );

  return (
    (
      buyFactor /
      sellFactor
    ) - 1
  ) * 100;
}

// ============================================================

function calculateBreakEvenBuyOKXSellCoinbase() {

  const buyFactor =
    (
      1 +
      CONFIG.okxSlippagePercent /
      100
    ) *
    (
      1 +
      CONFIG.okxFeePercent /
      100
    );

  const sellFactor =
    (
      1 -
      CONFIG.coinbaseSlippagePercent /
      100
    ) *
    (
      1 -
      CONFIG.coinbaseFeePercent /
      100
    );

  return (
    (
      buyFactor /
      sellFactor
    ) - 1
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

  const nowMs =
    Date.now();

  // ----------------------------------------------------------
  // NON PROFITTEVOLE
  // ----------------------------------------------------------

  if (!profitable) {

    if (
      direction ===
      "CB_OKX"
    ) {

      confirmation.cbToOkx = 0;

      confirmation.lastCbToOkx = 0;

    } else {

      confirmation.okxToCb = 0;

      confirmation.lastOkxToCb = 0;
    }

    return;
  }

  // ----------------------------------------------------------
  // COINBASE -> OKX
  // ----------------------------------------------------------

  if (
    direction ===
    "CB_OKX"
  ) {

    if (
      confirmation.lastCbToOkx === 0 ||
      nowMs -
      confirmation.lastCbToOkx >=
      CONFIG.confirmationInterval
    ) {

      confirmation.cbToOkx++;

      confirmation.lastCbToOkx =
        nowMs;
    }

    return;
  }

  // ----------------------------------------------------------
  // OKX -> COINBASE
  // ----------------------------------------------------------

  if (
    confirmation.lastOkxToCb === 0 ||
    nowMs -
    confirmation.lastOkxToCb >=
    CONFIG.confirmationInterval
  ) {

    confirmation.okxToCb++;

    confirmation.lastOkxToCb =
      nowMs;
  }
}

// ============================================================
// ARBITRAGGIO
// ============================================================

function checkArbitrage(symbol) {

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

  // ----------------------------------------------------------
  // CALCOLI
  // ----------------------------------------------------------

  const resultCBtoOKX =
    calculateCBtoOKX(
      cb,
      okx
    );

  const resultOKXtoCB =
    calculateOKXtoCB(
      cb,
      okx
    );

  // ----------------------------------------------------------
  // BREAK EVEN
  // ----------------------------------------------------------

  const breakEvenCBtoOKX =
    calculateBreakEvenBuyCoinbaseSellOKX();

  const breakEvenOKXtoCB =
    calculateBreakEvenBuyOKXSellCoinbase();

  stats.opportunities++;

  // ----------------------------------------------------------
  // PROFITTEVOLE?
  // ----------------------------------------------------------

  const profitableCBtoOKX =
    resultCBtoOKX.net >=
    CONFIG.minNetProfitPercent;

  const profitableOKXtoCB =
    resultOKXtoCB.net >=
    CONFIG.minNetProfitPercent;

  // ----------------------------------------------------------
  // CONFERME
  // ----------------------------------------------------------

  updateConfirmation(
    symbol,
    "CB_OKX",
    profitableCBtoOKX
  );

  updateConfirmation(
    symbol,
    "OKX_CB",
    profitableOKXtoCB
  );

  // ----------------------------------------------------------
  // DISPLAY
  // ----------------------------------------------------------

  displayStatus(
    symbol,
    cb,
    okx,
    resultCBtoOKX,
    resultOKXtoCB,
    breakEvenCBtoOKX,
    breakEvenOKXtoCB
  );

  // ----------------------------------------------------------
  // PAPER TRADE COINBASE -> OKX
  // ----------------------------------------------------------

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

      okx.bid,

      resultCBtoOKX.gross,

      resultCBtoOKX.net
    );

    confirmations[symbol]
      .cbToOkx = 0;

    confirmations[symbol]
      .lastCbToOkx = 0;
  }

  // ----------------------------------------------------------
  // PAPER TRADE OKX -> COINBASE
  // ----------------------------------------------------------

  if (
    confirmations[symbol].okxToCb >=
    CONFIG.requiredConfirmations
  ) {

    stats.profitableOpportunities++;

    executePaperTrade(

      symbol,

      "OKX",

      okx.ask,

      "Coinbase",

      cb.bid,

      resultOKXtoCB.gross,

      resultOKXtoCB.net
    );

    confirmations[symbol]
      .okxToCb = 0;

    confirmations[symbol]
      .lastOkxToCb = 0;
  }
}

// ============================================================
// DISPLAY MARKET
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

  console.log("");

  console.log(
    `CB -> OKX | Lordo: ${pct(result1.gross)} | Netto: ${pct(result1.net)}`
  );

  console.log(
    `OKX -> CB | Lordo: ${pct(result2.gross)} | Netto: ${pct(result2.net)}`
  );

  console.log("");

  console.log(
    `Break-even CB -> OKX: ${pct(breakEven1)}`
  );

  console.log(
    `Break-even OKX -> CB: ${pct(breakEven2)}`
  );

  console.log("");

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

  console.log("");

  console.log(
    `💰 Capitale PAPER: ${money(paper.capital)}`
  );

  console.log(
    `💵 Profitto totale: ${money(paper.totalProfit)}`
  );

  console.log(
    `📈 Operazioni: ${paper.trades}`
  );

  // ----------------------------------------------------------
  // STATO OPPORTUNITÀ
  // ----------------------------------------------------------

  if (
    result1.net >=
    CONFIG.minNetProfitPercent ||
    result2.net >=
    CONFIG.minNetProfitPercent
  ) {

    console.log(
      "🟢 POSSIBILE OPPORTUNITÀ PROFITTEVOLE"
    );

  } else {

    console.log(
      "⚪ Nessuna opportunità profittevole"
    );
  }

  console.log(
    "------------------------------------------------------------"
  );
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
  netPercent
) {

  // ==========================================================
  // SICUREZZA
  // ==========================================================

  if (
    netPercent <
    CONFIG.minNetProfitPercent
  ) {

    log(
      `⚠️ PAPER TRADE BLOCCATO: netto ${pct(netPercent)} sotto soglia`
    );

    return;
  }

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
    tradeAmount > paper.capital
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
      netPercent /
      100
    );

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

  } else {

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

  // ==========================================================
  // REPORT TRADE
  // ==========================================================

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
    "============================================================"
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

  console.log("");

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
    "🔒 ORDINI REALI: DISABILITATI"
  );

  console.log(
    "============================================================"
  );

  console.log("");
}

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
