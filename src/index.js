const WebSocket = require("ws");

const CONFIG = {
  pairs: {
    BTC: { coinbase: "BTC-USD", okx: "BTC-USDT" },
    ETH: { coinbase: "ETH-USD", okx: "ETH-USDT" }
  },

  initialCapital: 1000,
  tradePercentOfCapital: 20,

  minNetProfitPercent: 0.10,

  requiredConfirmations: 3,
  confirmationInterval: 1000,

  coinbaseFeePercent: 0.60,
  okxFeePercent: 0.10,

  coinbaseSlippagePercent: 0.05,
  okxSlippagePercent: 0.05,

  usdToUsdt: 1.0,

  paperTrading: true,
  realOrdersEnabled: false,

  // TELEGRAM ATTIVO MA SOLO PER TRADE CONFERMATI
  telegramEnabled: true,

  maxPriceAge: 2000,
  maxPriceDesync: 500,

  opportunityCooldown: 10000,

  reconnectDelay: 5000,

  statusInterval: 30000,

  marketScanInterval: 250,

  okxPingInterval: 20000,

  marketDataWatchdogInterval: 10000,
  marketDataTimeout: 15000
};


// ============================================================
// TELEGRAM
// ============================================================

const TELEGRAM_CHAT_ID = "1254274653";


async function sendTelegram(message) {

  if (!CONFIG.telegramEnabled) {
    return false;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    log("⚠️ Telegram: TELEGRAM_BOT_TOKEN non trovato.");
    return false;
  }

  try {

    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          disable_web_page_preview: true
        })
      }
    );


    if (!response.ok) {

      const body = await response.text();

      log(
        `❌ Telegram HTTP ${response.status}: ${body}`
      );

      return false;
    }


    log(
      "📲 Telegram: notifica TRADE CONFERMATO inviata."
    );

    return true;

  } catch (error) {

    log(
      `❌ Telegram error: ${error.message}`
    );

    return false;
  }
}


// ============================================================
// PAPER PORTFOLIO
// ============================================================

const paper = {

  initialCapital:
    CONFIG.initialCapital,

  capital:
    CONFIG.initialCapital,

  totalProfit:
    0,

  trades:
    0,

  winningTrades:
    0,

  losingTrades:
    0,

  volume:
    0,

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
// CONNECTION STATE
// ============================================================

const state = {

  coinbase: {
    ws: null,
    lastMessage: 0,
    reconnecting: false
  },

  okx: {
    ws: null,
    lastMessage: 0,
    reconnecting: false
  }

};


// ============================================================
// CONFIRMATIONS
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
// STATISTICS
// ============================================================

const stats = {

  checks: 0,

  opportunities: 0,

  profitableOpportunities: 0,

  coinbaseMessages: 0,

  coinbaseUpdates: 0,

  okxMessages: 0,

  okxUpdates: 0,

  lastDisplay: {
    BTC: 0,
    ETH: 0
  }

};


// ============================================================
// UTILITY
// ============================================================

function now() {

  return new Date()
    .toLocaleTimeString("it-IT");

}


function log(message) {

  console.log(
    `[${now()}] ${message}`
  );

}


function money(value) {

  return `€${Number(value).toFixed(2)}`;

}


function pct(value) {

  return `${Number(value).toFixed(4)}%`;

}


function valid(value) {

  return (
    Number.isFinite(value) &&
    value > 0
  );

}


// ============================================================
// PAIR LOOKUP
// ============================================================

function pairFromCoinbase(product) {

  for (
    const [symbol, pair]
    of Object.entries(CONFIG.pairs)
  ) {

    if (
      pair.coinbase === product
    ) {

      return symbol;

    }

  }

  return null;
}


function pairFromOKX(instId) {

  for (
    const [symbol, pair]
    of Object.entries(CONFIG.pairs)
  ) {

    if (
      pair.okx === instId
    ) {

      return symbol;

    }

  }

  return null;
}


// ============================================================
// PREZZI
// ============================================================

function pricesReady(symbol) {

  const book =
    books[symbol];

  return (

    valid(book.coinbase.bid) &&
    valid(book.coinbase.ask) &&
    valid(book.okx.bid) &&
    valid(book.okx.ask)

  );

}


function pricesFresh(symbol) {

  const book =
    books[symbol];

  const currentTime =
    Date.now();

  const cbAge =
    currentTime -
    book.coinbase.timestamp;

  const okxAge =
    currentTime -
    book.okx.timestamp;


  if (
    cbAge >
    CONFIG.maxPriceAge
  ) {

    return false;

  }


  if (
    okxAge >
    CONFIG.maxPriceAge
  ) {

    return false;

  }


  const desync =
    Math.abs(
      book.coinbase.timestamp -
      book.okx.timestamp
    );


  if (
    desync >
    CONFIG.maxPriceDesync
  ) {

    return false;

  }


  return true;
}


// ============================================================
// CALCOLO COINBASE -> OKX
// ============================================================

function calculateCBtoOKX(
  cb,
  okx
) {

  const okxBid =
    okx.bid /
    CONFIG.usdToUsdt;


  const buyPrice =
    cb.ask *
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


  const sellPrice =
    okxBid *
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


  const gross =
    (
      (
        okxBid -
        cb.ask
      ) /
      cb.ask
    ) *
    100;


  const net =
    (
      (
        sellPrice -
        buyPrice
      ) /
      buyPrice
    ) *
    100;


  return {

    gross,
    net,

    buyPrice,
    sellPrice

  };

}


// ============================================================
// CALCOLO OKX -> COINBASE
// ============================================================

function calculateOKXtoCB(
  cb,
  okx
) {

  const okxAsk =
    okx.ask /
    CONFIG.usdToUsdt;


  const buyPrice =
    okxAsk *
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


  const sellPrice =
    cb.bid *
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


  const gross =
    (
      (
        cb.bid -
        okxAsk
      ) /
      okxAsk
    ) *
    100;


  const net =
    (
      (
        sellPrice -
        buyPrice
      ) /
      buyPrice
    ) *
    100;


  return {

    gross,
    net,

    buyPrice,
    sellPrice

  };

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


  const isCB =
    direction === "CB_OKX";


  const counter =
    isCB
      ? "cbToOkx"
      : "okxToCb";


  const lastCounter =
    isCB
      ? "lastCbToOkx"
      : "lastOkxToCb";


  // Se non e' piu' redditizia,
  // azzeriamo immediatamente la conferma.

  if (!profitable) {

    confirmation[counter] = 0;

    confirmation[lastCounter] = 0;

    return;
  }


  // Una conferma al massimo ogni secondo.

  if (

    confirmation[lastCounter] === 0 ||

    (
      currentTime -
      confirmation[lastCounter]
    ) >=
    CONFIG.confirmationInterval

  ) {

    confirmation[counter]++;

    confirmation[lastCounter] =
      currentTime;

  }

}


// ============================================================
// DISPLAY CONSOLE
// ============================================================

function displayStatus(
  symbol,
  cb,
  okx,
  result1,
  result2
) {

  const currentTime =
    Date.now();


  if (

    currentTime -
    stats.lastDisplay[symbol] <
    1000

  ) {

    return;
  }


  stats.lastDisplay[symbol] =
    currentTime;


  const c =
    confirmations[symbol];


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
    `OKX -> CB | Lordo: ${pct(result2.gross)} | Netto: ${pct(result2.net)}`
  );


  console.log(
    `Conferma CB -> OKX: ${c.cbToOkx}/${CONFIG.requiredConfirmations}`
  );


  console.log(
    `Conferma OKX -> CB: ${c.okxToCb}/${CONFIG.requiredConfirmations}`
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
//
// IMPORTANTE:
// confirmedOperation DEVE essere true.
// Questo impedisce qualsiasi messaggio Telegram
// per semplici opportunita' o status.
// ============================================================

function executePaperTrade(

  symbol,

  buyExchange,
  buyPrice,

  sellExchange,
  sellPrice,

  grossPercent,
  netPercent,

  confirmedOperation

) {


  if (
    !CONFIG.paperTrading
  ) {

    return false;

  }


  if (
    CONFIG.realOrdersEnabled
  ) {

    log(
      "❌ BLOCCO SICUREZZA: ordini reali disabilitati."
    );

    return false;

  }


  // SICUREZZA ASSOLUTA:
  // senza conferma non facciamo nulla.

  if (
    confirmedOperation !== true
  ) {

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


  if (

    currentTime -
    paper.lastTradeTime[symbol] <
    CONFIG.opportunityCooldown

  ) {

    return false;

  }


  const tradeAmount =

    paper.capital *

    (
      CONFIG.tradePercentOfCapital /
      100
    );


  if (

    tradeAmount <= 0 ||

    tradeAmount >
    paper.capital

  ) {

    return false;

  }


  const profit =

    tradeAmount *

    (
      netPercent /
      100
    );


  if (
    profit <= 0
  ) {

    return false;

  }


  // ==========================================================
  // ESECUZIONE PAPER
  // ==========================================================

  paper.capital +=
    profit;


  paper.totalProfit +=
    profit;


  paper.trades++;


  paper.volume +=
    tradeAmount;


  paper.winningTrades++;


  paper.lastTradeTime[symbol] =
    currentTime;


  console.log("");

  console.log(
    "============================================================"
  );


  console.log(
    "🚨 OPPORTUNITÀ CONFERMATA"
  );


  console.log(
    "🚨 PAPER TRADE ESEGUITO"
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
    `CAPITALE DOPO: ${money(paper.capital)}`
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


  // ==========================================================
  // TELEGRAM
  // ==========================================================
  //
  // QUESTO E' L'UNICO INVIO TELEGRAM DI TUTTO IL PROGRAMMA.
  //
  // Arriviamo qui SOLO dopo:
  //
  // 1. opportunita' redditizia
  // 2. 3 conferme
  // 3. PAPER TRADE effettivamente eseguito
  //
  // ==========================================================

  void sendTelegram(

    `🚨 OPPORTUNITÀ CONFERMATA - PAPER TRADE ESEGUITO\n\n` +

    `Pair: ${symbol}\n` +

    `BUY: ${buyExchange} @ ${buyPrice.toFixed(2)}\n` +

    `SELL: ${sellExchange} @ ${sellPrice.toFixed(2)}\n` +

    `Spread lordo: ${pct(grossPercent)}\n` +

    `Profitto netto: ${pct(netPercent)}\n` +

    `Capitale operazione: ${money(tradeAmount)}\n` +

    `Profitto: ${money(profit)}\n` +

    `Capitale dopo: ${money(paper.capital)}\n` +

    `Operazioni totali: ${paper.trades}\n` +

    `🔒 Ordini reali: DISABILITATI`

  );


  return true;

}


// ============================================================
// ARBITRAGE ENGINE
// ============================================================

function checkArbitrage(
  symbol,
  allowConfirmation = true
) {

  stats.checks++;


  if (
    !pricesReady(symbol)
  ) {

    return;

  }


  if (
    !pricesFresh(symbol)
  ) {

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


  const profitable1 =

    result1.net >=
    CONFIG.minNetProfitPercent;


  const profitable2 =

    result2.net >=
    CONFIG.minNetProfitPercent;


  stats.opportunities++;


  // Le conferme vengono aggiornate SOLO
  // dai dati reali dei WebSocket.

  if (
    allowConfirmation
  ) {

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

  }


  displayStatus(
    symbol,
    cb,
    okx,
    result1,
    result2
  );


  // Lo scanner secondario non deve mai
  // creare conferme/trade.

  if (
    !allowConfirmation
  ) {

    return;

  }


  const c =
    confirmations[symbol];


  // ==========================================================
  // COINBASE -> OKX
  // ==========================================================

  if (

    profitable1 &&

    c.cbToOkx >=
    CONFIG.requiredConfirmations

  ) {

    stats.profitableOpportunities++;


    const executed =
      executePaperTrade(

        symbol,

        "Coinbase",
        cb.ask,

        "OKX",
        okx.bid,

        result1.gross,
        result1.net,

        true

      );


    if (
      executed
    ) {

      c.cbToOkx = 0;

      c.lastCbToOkx = 0;

    }

  }


  // ==========================================================
  // OKX -> COINBASE
  // ==========================================================

  if (

    profitable2 &&

    c.okxToCb >=
    CONFIG.requiredConfirmations

  ) {

    stats.profitableOpportunities++;


    const executed =
      executePaperTrade(

        symbol,

        "OKX",
        okx.ask,

        "Coinbase",
        cb.bid,

        result2.gross,
        result2.net,

        true

      );


    if (
      executed
    ) {

      c.okxToCb = 0;

      c.lastOkxToCb = 0;

    }

  }

}


// ============================================================
// COINBASE UPDATE
// ============================================================

function updateCoinbase(data) {

  if (
    !data ||
    !Array.isArray(data.events)
  ) {

    return;

  }


  for (
    const event of data.events
  ) {

    if (
      !event ||
      !Array.isArray(event.tickers)
    ) {

      continue;

    }


    for (
      const ticker of event.tickers
    ) {

      if (!ticker) {

        continue;

      }


      const symbol =
        pairFromCoinbase(
          ticker.product_id
        );


      if (!symbol) {

        continue;

      }


      const bid =
        Number(
          ticker.best_bid
        );


      const ask =
        Number(
          ticker.best_ask
        );


      let changed =
        false;


      if (
        valid(bid)
      ) {

        books[symbol]
          .coinbase
          .bid =
          bid;

        changed =
          true;

      }


      if (
        valid(ask)
      ) {

        books[symbol]
          .coinbase
          .ask =
          ask;

        changed =
          true;

      }


      if (
        changed
      ) {

        books[symbol]
          .coinbase
          .timestamp =
          Date.now();


        stats.coinbaseUpdates++;


        checkArbitrage(
          symbol,
          true
        );

      }

    }

  }

}


// ============================================================
// COINBASE CONNECTION
// ============================================================

function connectCoinbase() {

  if (

    state.coinbase.ws &&

    state.coinbase.ws.readyState ===
    WebSocket.OPEN

  ) {

    return;

  }


  const ws =
    new WebSocket(
      "wss://advanced-trade-ws.coinbase.com"
    );


  state.coinbase.ws =
    ws;


  state.coinbase.reconnecting =
    false;


  ws.on(
    "open",
    () => {

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

    }
  );


  ws.on(
    "message",
    raw => {

      try {

        stats.coinbaseMessages++;


        state.coinbase.lastMessage =
          Date.now();


        updateCoinbase(
          JSON.parse(
            raw.toString()
          )
        );


      } catch (error) {

        log(
          `❌ Errore Coinbase: ${error.message}`
        );

      }

    }
  );


  ws.on(
    "close",
    () => {

      if (
        state.coinbase.ws === ws
      ) {

        state.coinbase.ws =
          null;

      }


      if (
        state.coinbase.reconnecting
      ) {

        return;

      }


      state.coinbase.reconnecting =
        true;


      log(
        "🔴 Coinbase disconnesso. Riconnessione..."
      );


      setTimeout(
        () => {

          state.coinbase.reconnecting =
            false;

          connectCoinbase();

        },

        CONFIG.reconnectDelay

      );

    }
  );


  ws.on(
    "error",
    error => {

      log(
        `❌ Coinbase WebSocket error: ${error.message}`
      );

    }
  );

}


// ============================================================
// OKX UPDATE
// ============================================================

function updateOKX(data) {

  if (
    !data ||
    !data.arg
  ) {

    return;

  }


  if (
    data.arg.channel !==
    "bbo-tbt"
  ) {

    return;

  }


  const symbol =
    pairFromOKX(
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


  let changed =
    false;


  if (

    Array.isArray(book.bids) &&

    book.bids.length > 0

  ) {

    const bid =
      Number(
        book.bids[0][0]
      );


    if (
      valid(bid)
    ) {

      books[symbol]
        .okx
        .bid =
        bid;


      changed =
        true;

    }

  }


  if (

    Array.isArray(book.asks) &&

    book.asks.length > 0

  ) {

    const ask =
      Number(
        book.asks[0][0]
      );


    if (
      valid(ask)
    ) {

      books[symbol]
        .okx
        .ask =
        ask;


      changed =
        true;

    }

  }


  if (
    changed
  ) {

    books[symbol]
      .okx
      .timestamp =
      Date.now();


    stats.okxUpdates++;


    checkArbitrage(
      symbol,
      true
    );

  }

}


// ============================================================
// OKX CONNECTION
// ============================================================

function connectOKX() {

  if (

    state.okx.ws &&

    state.okx.ws.readyState ===
    WebSocket.OPEN

  ) {

    return;

  }


  const ws =
    new WebSocket(
      "wss://ws.okx.com:8443/ws/v5/public"
    );


  state.okx.ws =
    ws;


  state.okx.reconnecting =
    false;


  let pingTimer =
    null;


  ws.on(
    "open",
    () => {

      log(
        "🟢 OKX WebSocket CONNECTED"
      );


      ws.send(
        JSON.stringify({

          op: "subscribe",

          args: [

            {
              channel: "bbo-tbt",
              instId:
                CONFIG.pairs.BTC.okx
            },

            {
              channel: "bbo-tbt",
              instId:
                CONFIG.pairs.ETH.okx
            }

          ]

        })
      );


      log(
        "🟢 OKX subscriptions ATTIVE"
      );


      pingTimer =
        setInterval(
          () => {

            if (
              ws.readyState ===
              WebSocket.OPEN
            ) {

              ws.send(
                "ping"
              );

            }

          },

          CONFIG.okxPingInterval

        );

    }
  );


  ws.on(
    "message",
    raw => {

      try {

        stats.okxMessages++;


        state.okx.lastMessage =
          Date.now();


        const text =
          raw.toString();


        if (
          text === "ping"
        ) {

          if (
            ws.readyState ===
            WebSocket.OPEN
          ) {

            ws.send(
              "pong"
            );

          }

          return;

        }


        if (
          text === "pong"
        ) {

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


        updateOKX(
          data
        );


      } catch (error) {

        log(
          `❌ Errore OKX: ${error.message}`
        );

      }

    }
  );


  ws.on(
    "close",
    () => {

      if (
        pingTimer
      ) {

        clearInterval(
          pingTimer
        );

      }


      if (
        state.okx.ws === ws
      ) {

        state.okx.ws =
          null;

      }


      if (
        state.okx.reconnecting
      ) {

        return;

      }


      state.okx.reconnecting =
        true;


      log(
        "🔴 OKX disconnesso. Riconnessione..."
      );


      setTimeout(
        () => {

          state.okx.reconnecting =
            false;

          connectOKX();

        },

        CONFIG.reconnectDelay

      );

    }
  );


  ws.on(
    "error",
    error => {

      log(
        `❌ OKX WebSocket error: ${error.message}`
      );

    }
  );

}


// ============================================================
// PORTFOLIO REPORT
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
    "================ PAPER TRADING REPORT ====================="
  );


  console.log(
    `Capitale iniziale: ${money(paper.initialCapital)}`
  );


  console.log(
    `Capitale attuale:  ${money(paper.capital)}`
  );


  console.log(
    `Profitto totale:   ${money(paper.totalProfit)}`
  );


  console.log(
    `ROI:               ${pct(roi)}`
  );


  console.log(
    `Operazioni:        ${paper.trades}`
  );


  console.log(
    `Controlli mercato: ${stats.checks}`
  );


  console.log(
    `Opportunità viste: ${stats.opportunities}`
  );


  console.log(
    `Opportunità profittevoli: ${stats.profitableOpportunities}`
  );


  console.log(
    "🔒 ORDINI REALI: DISABILITATI"
  );


  console.log(
    "============================================================"
  );

}


// ============================================================
// AVVIO
// ============================================================

log(
  "============================================================"
);


log(
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE v14"
);


log(
  "📲 TELEGRAM: SOLO TRADE CONFERMATI"
);


log(
  `Capitale iniziale: ${money(CONFIG.initialCapital)}`
);


log(
  `Profitto netto minimo: ${CONFIG.minNetProfitPercent}%`
);


log(
  `Conferme richieste: ${CONFIG.requiredConfirmations}`
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
// REPORT CONSOLE
// ============================================================

setInterval(
  printPortfolio,
  CONFIG.statusInterval
);


// ============================================================
// SCANNER
// ============================================================
//
// NOTA:
// questo scanner NON puo' generare conferme
// e NON puo' generare messaggi Telegram.
// Serve solo per controllo continuo.
// ============================================================

setInterval(
  () => {

    checkArbitrage(
      "BTC",
      false
    );


    checkArbitrage(
      "ETH",
      false
    );

  },

  CONFIG.marketScanInterval
);


// ============================================================
// WATCHDOG
// ============================================================

setInterval(
  () => {

    const currentTime =
      Date.now();


    if (

      state.coinbase.ws &&

      state.coinbase.ws.readyState ===
      WebSocket.OPEN &&

      state.coinbase.lastMessage > 0 &&

      currentTime -
      state.coinbase.lastMessage >
      CONFIG.marketDataTimeout

    ) {

      log(
        "⚠️ Coinbase silenzioso: riconnessione watchdog."
      );


      try {

        state.coinbase.ws.close();

      } catch (_) {}

    }


    if (

      state.okx.ws &&

      state.okx.ws.readyState ===
      WebSocket.OPEN &&

      state.okx.lastMessage > 0 &&

      currentTime -
      state.okx.lastMessage >
      CONFIG.marketDataTimeout

    ) {

      log(
        "⚠️ OKX silenzioso: riconnessione watchdog."
      );


      try {

        state.okx.ws.close();

      } catch (_) {}

    }

  },

  CONFIG.marketDataWatchdogInterval

);


// ============================================================
// HEARTBEAT
// ============================================================

setInterval(
  () => {

    const cbState =

      state.coinbase.ws?.readyState ===
      WebSocket.OPEN

        ? "ONLINE"
        : "OFFLINE";


    const okxState =

      state.okx.ws?.readyState ===
      WebSocket.OPEN

        ? "ONLINE"
        : "OFFLINE";


    console.log(

      `[${now()}] ❤️ LIVE | ` +

      `Coinbase ${cbState} | ` +

      `OKX ${okxState} | ` +

      `Trades ${paper.trades} | ` +

      `Profitto ${money(paper.totalProfit)}`

    );

  },

  10000

);


// ============================================================
// PROTEZIONE PROCESSO
// ============================================================

process.on(
  "uncaughtException",
  error => {

    log(
      `UNCAUGHT EXCEPTION: ${error.message}`
    );

  }
);


process.on(
  "unhandledRejection",
  error => {

    log(
      `UNHANDLED REJECTION: ${String(error)}`
    );

  }
);
