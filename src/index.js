const WebSocket = require("ws");

// ============================================================
// CONFIGURAZIONE
// ============================================================
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

  maxPriceAge: 2000,
  maxPriceDesync: 500,
  opportunityCooldown: 10000,
  reconnectDelay: 5000,
  statusInterval: 30000,
  displayCooldown: 1000,
  marketScanInterval: 250,
  okxPingInterval: 20000,
  marketDataWatchdogInterval: 10000,
  marketDataTimeout: 15000,
  selfTestEnabled: true
};

const TELEGRAM_CHAT_ID = "1254274653";
let suppressTelegramNotifications = false;

// ============================================================
// STATO PAPER
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
// CONNECTIONS
// ============================================================
const connections = {
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
// CONFERME
// ============================================================
const confirmations = {
  BTC: {
    CB_OKX: 0,
    OKX_CB: 0,
    lastCB_OKX: 0,
    lastOKX_CB: 0
  },

  ETH: {
    CB_OKX: 0,
    OKX_CB: 0,
    lastCB_OKX: 0,
    lastOKX_CB: 0
  }
};

// ============================================================
// STATO NOTIFICHE OPPORTUNITÀ
// ============================================================
const telegramOpportunityState = {
  BTC: {
    CB_OKX: false,
    OKX_CB: false
  },

  ETH: {
    CB_OKX: false,
    OKX_CB: false
  }
};

// ============================================================
// STATISTICHE
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

function pairSymbolByCoinbase(productId) {
  return Object.keys(CONFIG.pairs).find(
    symbol =>
      CONFIG.pairs[symbol].coinbase === productId
  ) || null;
}

function pairSymbolByOKX(instId) {
  return Object.keys(CONFIG.pairs).find(
    symbol =>
      CONFIG.pairs[symbol].okx === instId
  ) || null;
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegram(message) {

  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {

    log(
      "⚠️ Telegram: TELEGRAM_BOT_TOKEN non configurato."
    );

    return false;
  }

  try {

    const response =
      await fetch(
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

      const body =
        await response.text();

      log(
        `❌ Telegram HTTP ${response.status}: ${body}`
      );

      return false;
    }

    log(
      "📲 Telegram: notifica inviata."
    );

    return true;

  } catch (error) {

    log(
      `❌ Telegram error: ${error.message}`
    );

    return false;
  }
}

function notifyTelegram(message) {

  if (
    suppressTelegramNotifications
  ) {
    return;
  }

  sendTelegram(message)
    .catch(error => {

      log(
        `❌ Telegram promise error: ${error.message}`
      );

    });
}

// ============================================================
// TELEGRAM STATO BOT
// ============================================================
function sendTelegramStatus() {

  const cbOnline =
    connections.coinbase.ws?.readyState ===
    WebSocket.OPEN;

  const okxOnline =
    connections.okx.ws?.readyState ===
    WebSocket.OPEN;

  const roi =
    (
      paper.totalProfit /
      paper.initialCapital
    ) * 100;

  notifyTelegram(

    `📊 STATO BOT\n\n` +

    `Coinbase: ${
      cbOnline
        ? "🟢 ONLINE"
        : "🔴 OFFLINE"
    }\n` +

    `OKX: ${
      okxOnline
        ? "🟢 ONLINE"
        : "🔴 OFFLINE"
    }\n\n` +

    `💰 Capitale PAPER: ${
      money(paper.capital)
    }\n` +

    `💵 Profitto: ${
      money(paper.totalProfit)
    }\n` +

    `📈 ROI: ${
      pct(roi)
    }\n` +

    `🔄 Operazioni: ${
      paper.trades
    }\n` +

    `🔎 Controlli: ${
      stats.checks
    }\n` +

    `🎯 Opportunità: ${
      stats.opportunities
    }\n` +

    `✅ Profittevoli: ${
      stats.profitableOpportunities
    }\n\n` +

    `Soglia netta: ${
      CONFIG.minNetProfitPercent
    }%\n` +

    `Conferme: ${
      CONFIG.requiredConfirmations
    }\n` +

    `Modalità: PAPER TRADING\n` +

    `🔒 Ordini reali: DISABILITATI`
  );
}

// ============================================================
// TELEGRAM OPPORTUNITÀ
// ============================================================
function notifyArbitrageOpportunity(
  symbol,
  direction,
  result
) {

  if (
    telegramOpportunityState[symbol][direction]
  ) {
    return;
  }

  telegramOpportunityState[symbol][direction] =
    true;

  const buyExchange =
    direction === "CB_OKX"
      ? "Coinbase"
      : "OKX";

  const sellExchange =
    direction === "CB_OKX"
      ? "OKX"
      : "Coinbase";

  const amount =
    paper.capital *
    CONFIG.tradePercentOfCapital /
    100;

  const estimatedProfit =
    amount *
    result.net /
    100;

  notifyTelegram(

    `🚨 OPPORTUNITÀ ARBITRAGGIO\n\n` +

    `Pair: ${symbol}\n` +

    `BUY: ${
      buyExchange
    } @ ${
      result.buyPrice.toFixed(2)
    }\n` +

    `SELL: ${
      sellExchange
    } @ ${
      result.sellPrice.toFixed(2)
    }\n` +

    `Spread lordo: ${
      pct(result.gross)
    }\n` +

    `Profitto netto: ${
      pct(result.net)
    }\n` +

    `Conferma: ${
      confirmations[symbol][direction]
    }/${
      CONFIG.requiredConfirmations
    }\n` +

    `Capitale operazione: ${
      money(amount)
    }\n` +

    `Profitto stimato: ${
      money(estimatedProfit)
    }\n\n` +

    `⏳ Il bot sta verificando le conferme.\n` +

    `⚠️ PAPER TRADING - nessun ordine reale`
  );
}

// ============================================================
// PREZZI PRONTI
// ============================================================
function pricesReady(symbol) {

  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;

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

  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;

  const current =
    Date.now();

  return (

    current - cb.timestamp <=
      CONFIG.maxPriceAge &&

    current - okx.timestamp <=
      CONFIG.maxPriceAge &&

    Math.abs(
      cb.timestamp -
      okx.timestamp
    ) <=
      CONFIG.maxPriceDesync

  );
}

// ============================================================
// COINBASE -> OKX
// ============================================================
function calculateCBtoOKX(
  cb,
  okx
) {

  const okxBidUSD =
    okx.bid /
    CONFIG.usdToUsdt;

  const buy =
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

  const sell =
    okxBidUSD *

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

  return {

    gross:
      (
        (
          okxBidUSD -
          cb.ask
        ) /
        cb.ask
      ) *
      100,

    net:
      (
        (
          sell -
          buy
        ) /
        buy
      ) *
      100,

    buyPrice:
      buy,

    sellPrice:
      sell

  };
}

// ============================================================
// OKX -> COINBASE
// ============================================================
function calculateOKXtoCB(
  cb,
  okx
) {

  const okxAskUSD =
    okx.ask /
    CONFIG.usdToUsdt;

  const buy =
    okxAskUSD *

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

  const sell =
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

  return {

    gross:
      (
        (
          cb.bid -
          okxAskUSD
        ) /
        okxAskUSD
      ) *
      100,

    net:
      (
        (
          sell -
          buy
        ) /
        buy
      ) *
      100,

    buyPrice:
      buy,

    sellPrice:
      sell

  };
}

// ============================================================
// TARGET LORDO
// ============================================================
function targetGrossForNet(
  buyFee,
  buySlip,
  sellFee,
  sellSlip
) {

  const buyFactor =

    (
      1 +
      buySlip /
      100
    ) *

    (
      1 +
      buyFee /
      100
    );

  const sellFactor =

    (
      1 -
      sellSlip /
      100
    ) *

    (
      1 -
      sellFee /
      100
    );

  return (

    (
      (
        1 +
        CONFIG.minNetProfitPercent /
        100
      ) *
      buyFactor /
      sellFactor
    ) -
    1

  ) * 100;
}

// ============================================================
// BREAK EVEN
// ============================================================
function breakEvenCBtoOKX() {

  return (
    targetGrossForNet(
      CONFIG.coinbaseFeePercent,
      CONFIG.coinbaseSlippagePercent,
      CONFIG.okxFeePercent,
      CONFIG.okxSlippagePercent
    ) -
    CONFIG.minNetProfitPercent
  );
}

function breakEvenOKXtoCB() {

  return (
    targetGrossForNet(
      CONFIG.okxFeePercent,
      CONFIG.okxSlippagePercent,
      CONFIG.coinbaseFeePercent,
      CONFIG.coinbaseSlippagePercent
    ) -
    CONFIG.minNetProfitPercent
  );
}

// ============================================================
// RESET CONFERME
// ============================================================
function resetConfirmation(
  symbol,
  direction
) {

  confirmations[symbol][direction] =
    0;

  confirmations[symbol][
    `last${direction}`
  ] = 0;

  telegramOpportunityState[symbol][direction] =
    false;
}

// ============================================================
// AGGIORNA CONFERME
// ============================================================
function updateConfirmation(
  symbol,
  direction,
  profitable
) {

  if (!profitable) {

    resetConfirmation(
      symbol,
      direction
    );

    return;
  }

  const current =
    Date.now();

  const lastKey =
    `last${direction}`;

  if (

    confirmations[symbol][lastKey] === 0 ||

    current -
      confirmations[symbol][lastKey] >=
      CONFIG.confirmationInterval

  ) {

    confirmations[symbol][direction]++;

    confirmations[symbol][lastKey] =
      current;
  }
}

// ============================================================
// PAPER TRADE
// ============================================================
function executePaperTrade(
  symbol,
  direction,
  result
) {

  if (
    !CONFIG.paperTrading ||
    CONFIG.realOrdersEnabled
  ) {
    return;
  }

  if (
    result.net <
    CONFIG.minNetProfitPercent
  ) {
    return;
  }

  if (
    confirmations[symbol][direction] <
    CONFIG.requiredConfirmations
  ) {
    return;
  }

  const current =
    Date.now();

  if (

    current -
      paper.lastTradeTime[symbol] <
      CONFIG.opportunityCooldown

  ) {
    return;
  }

  const amount =
    paper.capital *
    CONFIG.tradePercentOfCapital /
    100;

  const profit =
    amount *
    result.net /
    100;

  if (
    amount <= 0 ||
    profit <= 0
  ) {
    return;
  }

  const buyExchange =
    direction === "CB_OKX"
      ? "Coinbase"
      : "OKX";

  const sellExchange =
    direction === "CB_OKX"
      ? "OKX"
      : "Coinbase";

  const capitalBefore =
    paper.capital;

  paper.capital +=
    profit;

  paper.totalProfit +=
    profit;

  paper.trades++;

  paper.winningTrades++;

  paper.volume +=
    amount;

  paper.lastTradeTime[symbol] =
    current;

  stats.profitableOpportunities++;

  log(
    `🚨 PAPER TRADE ${symbol} | ` +
    `${buyExchange} -> ${sellExchange} | ` +
    `profitto ${money(profit)}`
  );

  notifyTelegram(

    `💰 PAPER TRADE ESEGUITO\n\n` +

    `Pair: ${symbol}\n` +

    `BUY: ${
      buyExchange
    } @ ${
      result.buyPrice.toFixed(2)
    }\n` +

    `SELL: ${
      sellExchange
    } @ ${
      result.sellPrice.toFixed(2)
    }\n` +

    `Spread lordo: ${
      pct(result.gross)
    }\n` +

    `Profitto netto: ${
      pct(result.net)
    }\n` +

    `Capitale operazione: ${
      money(amount)
    }\n` +

    `Profitto: ${
      money(profit)
    }\n` +

    `Capitale prima: ${
      money(capitalBefore)
    }\n` +

    `Capitale dopo: ${
      money(paper.capital)
    }\n` +

    `Operazioni totali: ${
      paper.trades
    }\n\n` +

    `🔒 ORDINI REALI: DISABILITATI`
  );
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
    !pricesReady(symbol) ||
    !pricesFresh(symbol)
  ) {
    return;
  }

  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;

  const resultCB =
    calculateCBtoOKX(
      cb,
      okx
    );

  const resultOKX =
    calculateOKXtoCB(
      cb,
      okx
    );

  const targetCB =
    targetGrossForNet(
      CONFIG.coinbaseFeePercent,
      CONFIG.coinbaseSlippagePercent,
      CONFIG.okxFeePercent,
      CONFIG.okxSlippagePercent
    );

  const targetOKX =
    targetGrossForNet(
      CONFIG.okxFeePercent,
      CONFIG.okxSlippagePercent,
      CONFIG.coinbaseFeePercent,
      CONFIG.coinbaseSlippagePercent
    );

  if (
    resultCB.gross > 0 ||
    resultOKX.gross > 0
  ) {
    stats.opportunities++;
  }

  const profitableCB =
    resultCB.net >=
    CONFIG.minNetProfitPercent;

  const profitableOKX =
    resultOKX.net >=
    CONFIG.minNetProfitPercent;

  if (allowConfirmation) {

    updateConfirmation(
      symbol,
      "CB_OKX",
      profitableCB
    );

    updateConfirmation(
      symbol,
      "OKX_CB",
      profitableOKX
    );

    if (profitableCB) {

      notifyArbitrageOpportunity(
        symbol,
        "CB_OKX",
        resultCB
      );

    }

    if (profitableOKX) {

      notifyArbitrageOpportunity(
        symbol,
        "OKX_CB",
        resultOKX
      );

    }

    if (profitableCB) {

      executePaperTrade(
        symbol,
        "CB_OKX",
        resultCB
      );

      if (
        confirmations[symbol].CB_OKX >=
        CONFIG.requiredConfirmations
      ) {

        resetConfirmation(
          symbol,
          "CB_OKX"
        );

      }

    }

    if (profitableOKX) {

      executePaperTrade(
        symbol,
        "OKX_CB",
        resultOKX
      );

      if (
        confirmations[symbol].OKX_CB >=
        CONFIG.requiredConfirmations
      ) {

        resetConfirmation(
          symbol,
          "OKX_CB"
        );

      }

    }
  }

  const current =
    Date.now();

  if (

    current -
      stats.lastDisplay[symbol] >=
      CONFIG.displayCooldown

  ) {

    stats.lastDisplay[symbol] =
      current;

    log(

      `📊 ${symbol} | ` +

      `CB ${
        cb.bid.toFixed(2)
      }/${
        cb.ask.toFixed(2)
      } | ` +

      `OKX ${
        okx.bid.toFixed(2)
      }/${
        okx.ask.toFixed(2)
      } | ` +

      `CB→OKX lordo ${
        pct(resultCB.gross)
      } netto ${
        pct(resultCB.net)
      } | ` +

      `OKX→CB lordo ${
        pct(resultOKX.gross)
      } netto ${
        pct(resultOKX.net)
      } | ` +

      `target ${
        pct(targetCB)
      }/${
        pct(targetOKX)
      } | ` +

      `conf ${
        confirmations[symbol].CB_OKX
      }/${
        confirmations[symbol].OKX_CB
      }`
    );
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

      const symbol =
        pairSymbolByCoinbase(
          ticker?.product_id
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

      if (
        !validNumber(bid) ||
        !validNumber(ask)
      ) {
        continue;
      }

      books[symbol].coinbase.bid =
        bid;

      books[symbol].coinbase.ask =
        ask;

      books[symbol].coinbase.timestamp =
        Date.now();

      stats.coinbaseUpdates++;

      checkArbitrage(
        symbol,
        true
      );
    }
  }
}

// ============================================================
// COINBASE CONNECTION
// ============================================================
function connectCoinbase() {

  if (

    connections.coinbase.ws &&

    connections.coinbase.ws.readyState ===
      WebSocket.OPEN

  ) {
    return;
  }

  const ws =
    new WebSocket(
      "wss://advanced-trade-ws.coinbase.com"
    );

  connections.coinbase.ws =
    ws;

  connections.coinbase.reconnecting =
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

      stats.coinbaseMessages++;

      connections.coinbase.lastMessage =
        Date.now();

      try {

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
        connections.coinbase.ws ===
        ws
      ) {

        connections.coinbase.ws =
          null;
      }

      if (
        connections.coinbase.reconnecting
      ) {
        return;
      }

      connections.coinbase.reconnecting =
        true;

      log(
        "🔴 Coinbase DISCONNESSO"
      );

      notifyTelegram(
        "🔴 Coinbase DISCONNESSO\n\n" +
        "🔄 Riconnessione automatica in corso..."
      );

      setTimeout(
        () => {

          connections.coinbase.reconnecting =
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
    !data?.arg ||
    data.arg.channel !==
      "bbo-tbt"
  ) {
    return;
  }

  const symbol =
    pairSymbolByOKX(
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

  const bid =
    Array.isArray(book.bids) &&
    book.bids[0]
      ? Number(book.bids[0][0])
      : null;

  const ask =
    Array.isArray(book.asks) &&
    book.asks[0]
      ? Number(book.asks[0][0])
      : null;

  if (
    !validNumber(bid) ||
    !validNumber(ask)
  ) {
    return;
  }

  books[symbol].okx.bid =
    bid;

  books[symbol].okx.ask =
    ask;

  books[symbol].okx.timestamp =
    Date.now();

  stats.okxUpdates++;

  checkArbitrage(
    symbol,
    true
  );
}

// ============================================================
// OKX CONNECTION
// ============================================================
function connectOKX() {

  if (

    connections.okx.ws &&

    connections.okx.ws.readyState ===
      WebSocket.OPEN

  ) {
    return;
  }

  const ws =
    new WebSocket(
      "wss://ws.okx.com:8443/ws/v5/public"
    );

  connections.okx.ws =
    ws;

  connections.okx.reconnecting =
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

      stats.okxMessages++;

      connections.okx.lastMessage =
        Date.now();

      try {

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

        updateOKX(data);

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

      if (pingTimer) {
        clearInterval(
          pingTimer
        );
      }

      if (
        connections.okx.ws ===
        ws
      ) {

        connections.okx.ws =
          null;
      }

      if (
        connections.okx.reconnecting
      ) {
        return;
      }

      connections.okx.reconnecting =
        true;

      log(
        "🔴 OKX DISCONNESSO"
      );

      notifyTelegram(
        "🔴 OKX DISCONNESSO\n\n" +
        "🔄 Riconnessione automatica in corso..."
      );

      setTimeout(
        () => {

          connections.okx.reconnecting =
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
// REPORT
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
    `Capitale iniziale: ${
      money(paper.initialCapital)
    }`
  );

  console.log(
    `Capitale attuale:  ${
      money(paper.capital)
    }`
  );

  console.log(
    `Profitto totale:   ${
      money(paper.totalProfit)
    }`
  );

  console.log(
    `ROI:               ${
      pct(roi)
    }`
  );

  console.log(
    `Operazioni:        ${
      paper.trades
    }`
  );

  console.log(
    `Vincenti:          ${
      paper.winningTrades
    }`
  );

  console.log(
    `Perdenti:          ${
      paper.losingTrades
    }`
  );

  console.log(
    `Volume PAPER:      ${
      money(paper.volume)
    }`
  );

  console.log(
    `Controlli mercato: ${
      stats.checks
    }`
  );

  console.log(
    `Opportunità viste: ${
      stats.opportunities
    }`
  );

  console.log(
    `Opportunità profittevoli: ${
      stats.profitableOpportunities
    }`
  );

  console.log(
    `Coinbase messaggi: ${
      stats.coinbaseMessages
    }`
  );

  console.log(
    `Coinbase update:   ${
      stats.coinbaseUpdates
    }`
  );

  console.log(
    `OKX messaggi:      ${
      stats.okxMessages
    }`
  );

  console.log(
    `OKX update:        ${
      stats.okxUpdates
    }`
  );

  console.log(
    `Soglia netto:      ${
      CONFIG.minNetProfitPercent
    }%`
  );

  console.log(
    `Conferme richieste: ${
      CONFIG.requiredConfirmations
    }`
  );

  console.log(
    `Trade:             ${
      CONFIG.tradePercentOfCapital
    }% del capitale`
  );

  console.log(
    `Break-even CB→OKX: ${
      pct(breakEvenCBtoOKX())
    }`
  );

  console.log(
    `Break-even OKX→CB: ${
      pct(breakEvenOKXtoCB())
    }`
  );

  console.log(
    "🔒 ORDINI REALI: DISABILITATI"
  );

  console.log(
    "============================================================"
  );

  sendTelegramStatus();
}

// ============================================================
// SELF TEST
// ============================================================
function runPaperSelfTest() {

  if (
    !CONFIG.selfTestEnabled ||
    !CONFIG.paperTrading ||
    CONFIG.realOrdersEnabled
  ) {
    return;
  }

  const saved = {

    capital:
      paper.capital,

    totalProfit:
      paper.totalProfit,

    trades:
      paper.trades,

    winningTrades:
      paper.winningTrades,

    losingTrades:
      paper.losingTrades,

    volume:
      paper.volume,

    lastTradeTime:
      {
        ...paper.lastTradeTime
      }

  };

  try {

    suppressTelegramNotifications =
      true;

    log(
      "🧪 SELF TEST PAPER: verifica conferme e trade..."
    );

    confirmations.BTC.CB_OKX =
      CONFIG.requiredConfirmations;

    confirmations.BTC.lastCB_OKX =
      Date.now();

    const testResult = {

      gross: 2.0,

      net:
        Math.max(
          CONFIG.minNetProfitPercent +
          0.50,
          0.60
        ),

      buyPrice:
        78000,

      sellPrice:
        80000
    };

    executePaperTrade(
      "BTC",
      "CB_OKX",
      testResult
    );

    log(
      "✅ SELF TEST PAPER COMPLETATO."
    );

  } catch (error) {

    log(
      `❌ SELF TEST PAPER FALLITO: ${error.message}`
    );

  } finally {

    suppressTelegramNotifications =
      false;

    paper.capital =
      saved.capital;

    paper.totalProfit =
      saved.totalProfit;

    paper.trades =
      saved.trades;

    paper.winningTrades =
      saved.winningTrades;

    paper.losingTrades =
      saved.losingTrades;

    paper.volume =
      saved.volume;

    paper.lastTradeTime =
      {
        ...saved.lastTradeTime
      };

    resetConfirmation(
      "BTC",
      "CB_OKX"
    );

    log(
      "🔄 SELF TEST: dati PAPER ripristinati."
    );
  }
}

// ============================================================
// AVVIO
// ============================================================
log(
  "============================================================"
);

log(
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE v12"
);

log(
  `💰 Capitale iniziale: ${
    money(CONFIG.initialCapital)
  }`
);

log(
  `🎯 Profitto netto minimo: ${
    CONFIG.minNetProfitPercent
  }%`
);

log(
  `🔢 Conferme richieste: ${
    CONFIG.requiredConfirmations
  }`
);

log(
  "🔒 ORDINI REALI: DISABILITATI"
);

log(
  "============================================================"
);

// ============================================================
// TELEGRAM AVVIO
// ============================================================
notifyTelegram(

  `🟢 CRYPTO ARBITRAGE PAPER ENGINE AVVIATO\n\n` +

  `Modalità: PAPER TRADING\n` +

  `Capitale iniziale: ${
    money(CONFIG.initialCapital)
  }\n` +

  `Coppie: BTC / ETH\n` +

  `Profitto netto minimo: ${
    CONFIG.minNetProfitPercent
  }%\n` +

  `Conferme richieste: ${
    CONFIG.requiredConfirmations
  }\n` +

  `🔒 Ordini reali: DISABILITATI`
);

// ============================================================
// AVVIO CONNECTIONS
// ============================================================
connectCoinbase();
connectOKX();

// ============================================================
// REPORT TELEGRAM OGNI 30 SECONDI
// ============================================================
setInterval(
  printPortfolio,
  CONFIG.statusInterval
);

// ============================================================
// SELF TEST
// ============================================================
setTimeout(
  runPaperSelfTest,
  3000
);

// ============================================================
// SCANNER CONTINUO
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
// MARKET DATA WATCHDOG
// ============================================================
setInterval(
  () => {

    const current =
      Date.now();

    if (

      connections.coinbase.ws?.readyState ===
        WebSocket.OPEN &&

      connections.coinbase.lastMessage > 0 &&

      current -
        connections.coinbase.lastMessage >
        CONFIG.marketDataTimeout

    ) {

      log(
        "⚠️ Coinbase silenzioso: watchdog riconnessione."
      );

      try {

        connections.coinbase.ws.close();

      } catch (error) {

        log(
          `⚠️ Coinbase watchdog: ${error.message}`
        );
      }
    }

    if (

      connections.okx.ws?.readyState ===
        WebSocket.OPEN &&

      connections.okx.lastMessage > 0 &&

      current -
        connections.okx.lastMessage >
        CONFIG.marketDataTimeout

    ) {

      log(
        "⚠️ OKX silenzioso: watchdog riconnessione."
      );

      try {

        connections.okx.ws.close();

      } catch (error) {

        log(
          `⚠️ OKX watchdog: ${error.message}`
        );
      }
    }

  },
  CONFIG.marketDataWatchdogInterval
);

// ============================================================
// LIVE HEARTBEAT
// ============================================================
setInterval(
  () => {

    const cb =
      connections.coinbase.ws?.readyState ===
      WebSocket.OPEN
        ? "ONLINE"
        : "OFFLINE";

    const okx =
      connections.okx.ws?.readyState ===
      WebSocket.OPEN
        ? "ONLINE"
        : "OFFLINE";

    log(

      `❤️ LIVE | ` +

      `Coinbase ${cb} | ` +

      `OKX ${okx} | ` +

      `Trades ${paper.trades} | ` +

      `Profitto ${
        money(paper.totalProfit)
      } | ` +

      `Checks ${stats.checks}`

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
      `❌ UNCAUGHT EXCEPTION: ${error.message}`
    );
  }
);

process.on(
  "unhandledRejection",
  error => {

    log(
      `❌ UNHANDLED REJECTION: ${String(error)}`
    );
  }
);
