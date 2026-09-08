const WebSocket = require("ws");

// ============================================================
// CRYPTO ARBITRAGE BOT - PAPER TRADING
// ============================================================

const CONFIG = {

  // ----------------------------------------------------------
  // COPPIE
  // ----------------------------------------------------------

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

  capitalEUR: 1000,

  paperTrading: true,

  // ----------------------------------------------------------
  // CAMBIO USD / USDT
  // ----------------------------------------------------------

  usdToUsdt: 1.0,

  // ----------------------------------------------------------
  // COMMISSIONI
  //
  // Valori iniziali conservativi:
  // Coinbase taker = 0.60%
  // OKX taker      = 0.10%
  //
  // MODIFICABILI in futuro in base alle tue commissioni reali.
  // ----------------------------------------------------------

  fees: {
    coinbaseTaker: 0.60,
    okxTaker: 0.10
  },

  // ----------------------------------------------------------
  // SLIPPAGE SIMULATO
  //
  // Aggiungiamo un piccolo margine per simulare differenze
  // tra prezzo visualizzato e prezzo effettivo di esecuzione.
  // ----------------------------------------------------------

  slippagePercent: 0.05,

  // ----------------------------------------------------------
  // SOGLIA MINIMA DI PROFITTO NETTO
  // ----------------------------------------------------------

  minNetProfitPercent: 0.10,

  // ----------------------------------------------------------
  // INTERVALLO REPORT
  // ----------------------------------------------------------

  reportInterval: 10000,

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
  coinbaseUpdates: 0,

  okxMessages: 0,
  okxUpdates: 0,

  profitableOpportunities: 0
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


function money(value) {

  return Number(value).toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}


function percent(value) {

  return Number(value).toFixed(4);
}


// ============================================================
// CALCOLO ARBITRAGGIO
// ============================================================

function calculateOpportunity(
  capital,
  buyPrice,
  sellPrice,
  buyFee,
  sellFee,
  direction
) {

  if (
    !Number.isFinite(buyPrice) ||
    !Number.isFinite(sellPrice) ||
    buyPrice <= 0 ||
    sellPrice <= 0
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // SLIPPAGE
  // ----------------------------------------------------------

  let effectiveBuyPrice;
  let effectiveSellPrice;

  if (direction === "CB_TO_OKX") {

    effectiveBuyPrice =
      buyPrice * (1 + CONFIG.slippagePercent / 100);

    effectiveSellPrice =
      sellPrice * (1 - CONFIG.slippagePercent / 100);

  } else {

    effectiveBuyPrice =
      buyPrice * (1 + CONFIG.slippagePercent / 100);

    effectiveSellPrice =
      sellPrice * (1 - CONFIG.slippagePercent / 100);
  }


  // ----------------------------------------------------------
  // ACQUISTO
  // ----------------------------------------------------------

  const quantity =
    capital / effectiveBuyPrice;


  // ----------------------------------------------------------
  // COMMISSIONE ACQUISTO
  // ----------------------------------------------------------

  const quantityAfterBuyFee =
    quantity * (1 - buyFee / 100);


  // ----------------------------------------------------------
  // VENDITA
  // ----------------------------------------------------------

  const grossSellValue =
    quantityAfterBuyFee * effectiveSellPrice;


  // ----------------------------------------------------------
  // COMMISSIONE VENDITA
  // ----------------------------------------------------------

  const finalCapital =
    grossSellValue * (1 - sellFee / 100);


  // ----------------------------------------------------------
  // PROFITTO
  // ----------------------------------------------------------

  const profitEUR =
    finalCapital - capital;


  const netPercent =
    (profitEUR / capital) * 100;


  // ----------------------------------------------------------
  // SPREAD LORDO
  // ----------------------------------------------------------

  const grossSpread =
    ((sellPrice - buyPrice) / buyPrice) * 100;


  return {

    direction,

    buyPrice,
    sellPrice,

    grossSpread,

    finalCapital,

    profitEUR,

    netPercent,

    buyFee,
    sellFee
  };
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


      const productId =
        ticker.product_id;


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

        books[symbol].coinbase.bid =
          bestBid;
      }


      if (
        Number.isFinite(bestAsk) &&
        bestAsk > 0
      ) {

        books[symbol].coinbase.ask =
          bestAsk;
      }


      stats.coinbaseUpdates++;
    }
  }
}


// ============================================================
// CONNECT COINBASE
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

  stats.okxMessages++;


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

      books[symbol].okx.bid =
        bid;
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

      books[symbol].okx.ask =
        ask;
    }
  }


  stats.okxUpdates++;
}


// ============================================================
// CONNECT OKX
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
// ANALISI
// ============================================================

function analyzePair(symbol) {

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

    return null;
  }


  // ----------------------------------------------------------
  // USD / USDT
  // ----------------------------------------------------------

  const okxBidUSD =
    okx.bid / CONFIG.usdToUsdt;


  const okxAskUSD =
    okx.ask / CONFIG.usdToUsdt;


  // ----------------------------------------------------------
  // CB -> OKX
  //
  // COMPRA Coinbase ASK
  // VENDE OKX BID
  // ----------------------------------------------------------

  const cbToOkx =
    calculateOpportunity(

      CONFIG.capitalEUR,

      cb.ask,

      okxBidUSD,

      CONFIG.fees.coinbaseTaker,

      CONFIG.fees.okxTaker,

      "CB_TO_OKX"
    );


  // ----------------------------------------------------------
  // OKX -> CB
  //
  // COMPRA OKX ASK
  // VENDE Coinbase BID
  // ----------------------------------------------------------

  const okxToCb =
    calculateOpportunity(

      CONFIG.capitalEUR,

      okxAskUSD,

      cb.bid,

      CONFIG.fees.okxTaker,

      CONFIG.fees.coinbaseTaker,

      "OKX_TO_CB"
    );


  return {
    cbToOkx,
    okxToCb
  };
}


// ============================================================
// BREAK EVEN
// ============================================================

function calculateBreakEven(buyFee, sellFee) {

  const feeMultiplier =
    (1 - buyFee / 100) *
    (1 - sellFee / 100);


  const slippageMultiplier =
    (1 - CONFIG.slippagePercent / 100) /
    (1 + CONFIG.slippagePercent / 100);


  const requiredRatio =
    1 /
    (feeMultiplier * slippageMultiplier);


  return (requiredRatio - 1) * 100;
}


// ============================================================
// REPORT
// ============================================================

function reportPair(symbol) {

  const result =
    analyzePair(symbol);


  if (!result) {
    return;
  }


  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;


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
    `CB -> OKX | Lordo: ${percent(result.cbToOkx.grossSpread)}% | Netto: ${percent(result.cbToOkx.netPercent)}% | Profitto: €${money(result.cbToOkx.profitEUR)}`
  );


  console.log(
    `OKX -> CB | Lordo: ${percent(result.okxToCb.grossSpread)}% | Netto: ${percent(result.okxToCb.netPercent)}% | Profitto: €${money(result.okxToCb.profitEUR)}`
  );


  const breakEvenCBOKX =
    calculateBreakEven(
      CONFIG.fees.coinbaseTaker,
      CONFIG.fees.okxTaker
    );


  const breakEvenOKXCB =
    calculateBreakEven(
      CONFIG.fees.okxTaker,
      CONFIG.fees.coinbaseTaker
    );


  console.log("");


  console.log(
    `Break-even CB -> OKX: ${percent(breakEvenCBOKX)}%`
  );


  console.log(
    `Break-even OKX -> CB: ${percent(breakEvenOKXCB)}%`
  );


  // ----------------------------------------------------------
  // OPPORTUNITÀ
  // ----------------------------------------------------------

  let profitable = false;


  if (
    result.cbToOkx.netPercent >=
    CONFIG.minNetProfitPercent
  ) {

    profitable = true;

    stats.profitableOpportunities++;


    console.log("");
    console.log(
      "🚨🚨🚨 OPPORTUNITÀ PROFITTEVOLE 🚨🚨🚨"
    );


    console.log(
      `BUY  Coinbase @ ${cb.ask}`
    );


    console.log(
      `SELL OKX @ ${okx.bid}`
    );


    console.log(
      `ROI NETTO: ${percent(result.cbToOkx.netPercent)}%`
    );


    console.log(
      `PROFITTO SIMULATO: €${money(result.cbToOkx.profitEUR)}`
    );


    console.log(
      `CAPITALE: €${money(CONFIG.capitalEUR)}`
    );


    console.log(
      "MODE: PAPER TRADING"
    );


    console.log(
      "ORDINI REALI: DISABILITATI"
    );
  }


  if (
    result.okxToCb.netPercent >=
    CONFIG.minNetProfitPercent
  ) {

    profitable = true;

    stats.profitableOpportunities++;


    console.log("");
    console.log(
      "🚨🚨🚨 OPPORTUNITÀ PROFITTEVOLE 🚨🚨🚨"
    );


    console.log(
      `BUY  OKX @ ${okx.ask}`
    );


    console.log(
      `SELL Coinbase @ ${cb.bid}`
    );


    console.log(
      `ROI NETTO: ${percent(result.okxToCb.netPercent)}%`
    );


    console.log(
      `PROFITTO SIMULATO: €${money(result.okxToCb.profitEUR)}`
    );


    console.log(
      `CAPITALE: €${money(CONFIG.capitalEUR)}`
    );


    console.log(
      "MODE: PAPER TRADING"
    );


    console.log(
      "ORDINI REALI: DISABILITATI"
    );
  }


  if (!profitable) {

    console.log(
      "Nessuna opportunità profittevole."
    );
  }


  console.log(
    "------------------------------------------------------------"
  );
}


// ============================================================
// STATUS
// ============================================================

function reportStatus() {

  console.log("");
  console.log(
    "============================================================"
  );


  console.log(
    `STATUS ${now()}`
  );


  console.log(
    "============================================================"
  );


  console.log(
    `Modalità: PAPER TRADING`
  );


  console.log(
    `Capitale simulato: €${money(CONFIG.capitalEUR)}`
  );


  console.log(
    `Commissione Coinbase TAKER: ${CONFIG.fees.coinbaseTaker}%`
  );


  console.log(
    `Commissione OKX TAKER: ${CONFIG.fees.okxTaker}%`
  );


  console.log(
    `Slippage simulato: ${CONFIG.slippagePercent}%`
  );


  console.log(
    `Soglia profitto netto: ${CONFIG.minNetProfitPercent}%`
  );


  console.log("");


  reportPair("BTC");

  reportPair("ETH");


  console.log("");


  console.log(
    `Coinbase messaggi: ${stats.coinbaseMessages} | Aggiornamenti: ${stats.coinbaseUpdates}`
  );


  console.log(
    `OKX messaggi: ${stats.okxMessages} | Aggiornamenti: ${stats.okxUpdates}`
  );


  console.log(
    `Opportunità profittevoli: ${stats.profitableOpportunities}`
  );


  console.log(
    "============================================================"
  );
}


// ============================================================
// START
// ============================================================

console.log("");

log(
  "============================================================"
);

log(
  "🚀 CRYPTO ARBITRAGE SCANNER"
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
  `Capitale simulato: €${money(CONFIG.capitalEUR)}`
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
  `Coinbase TAKER: ${CONFIG.fees.coinbaseTaker}%`
);

log(
  `OKX TAKER: ${CONFIG.fees.okxTaker}%`
);

log(
  `Slippage: ${CONFIG.slippagePercent}%`
);

log(
  "============================================================"
);


connectCoinbase();

connectOKX();


// Report ogni 10 secondi

setInterval(
  reportStatus,
  CONFIG.reportInterval
);
