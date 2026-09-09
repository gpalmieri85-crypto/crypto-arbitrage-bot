const WebSocket = require("ws");

const CONFIG = {
  pairs: {
    BTC: { coinbase: "BTC-USD", okx: "BTC-USDT" },
    ETH: { coinbase: "ETH-USD", okx: "ETH-USDT" }
  },

  initialCapital: 1000,
  tradePercentOfCapital: 20,

  // Profitto NETTO minimo dopo commissioni + slippage
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
  telegramOpportunityCooldown: 30000,

  marketScanInterval: 250,
  okxPingInterval: 20000,
  marketDataWatchdogInterval: 10000,
  marketDataTimeout: 15000,

  // DISATTIVATO per evitare falsi conteggi
  selfTestEnabled: false
};

const TELEGRAM_CHAT_ID = "1254274653";


/* ============================================================
   PAPER ACCOUNT
============================================================ */

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


/* ============================================================
   MARKET BOOKS
============================================================ */

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


/* ============================================================
   CONNECTION STATE
============================================================ */

const connectionState = {
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


/* ============================================================
   CONFIRMATIONS
============================================================ */

const confirmations = {
  BTC: {
    cbToOkx: 0,
    okxToCb: 0,

    lastCbToOkx: 0,
    lastOkxToCb: 0,

    notifiedCbToOkx: false,
    notifiedOkxToCb: false
  },

  ETH: {
    cbToOkx: 0,
    okxToCb: 0,

    lastCbToOkx: 0,
    lastOkxToCb: 0,

    notifiedCbToOkx: false,
    notifiedOkxToCb: false
  }
};


/* ============================================================
   STATISTICS
============================================================ */

const stats = {
  coinbaseMessages: 0,
  coinbaseUpdates: 0,

  okxMessages: 0,
  okxUpdates: 0,

  checks: 0,

  /*
   * Opportunità realmente profittevoli IN QUESTO MOMENTO.
   * Non viene incrementato ad ogni controllo.
   */
  currentOpportunities: 0,

  /*
   * Conteggio cumulativo.
   * Aumenta SOLO quando una opportunità raggiunge 3 conferme.
   */
  confirmedOpportunities: 0,

  /*
   * Conteggio cumulativo delle operazioni PAPER realmente simulate.
   */
  executedOpportunities: 0,

  lastDisplayTime: {
    BTC: 0,
    ETH: 0
  },

  lastTelegramOpportunity: {
    BTC_CB_OKX: 0,
    BTC_OKX_CB: 0,

    ETH_CB_OKX: 0,
    ETH_OKX_CB: 0
  },

  lastTelegramStatus: 0
};


/* ============================================================
   HELPERS
============================================================ */

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


/* ============================================================
   TELEGRAM
============================================================ */

async function sendTelegram(message) {

  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {

    log(
      "⚠️ Telegram: Secret TELEGRAM_BOT_TOKEN non trovato."
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

  sendTelegram(message)
    .catch(error => {

      log(
        `❌ Telegram promise error: ${error.message}`
      );

    });
}


/* ============================================================
   PAIR LOOKUP
============================================================ */

function getPairByCoinbaseProduct(productId) {

  for (
    const [symbol, pair]
    of Object.entries(CONFIG.pairs)
  ) {

    if (
      pair.coinbase === productId
    ) {

      return symbol;
    }
  }

  return null;
}


function getPairByOKXProduct(instId) {

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


/* ============================================================
   PRICE VALIDATION
============================================================ */

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


function pricesFresh(symbol) {

  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;

  const currentTime =
    Date.now();


  if (
    currentTime -
    cb.timestamp >
    CONFIG.maxPriceAge
  ) {

    return false;
  }


  if (
    currentTime -
    okx.timestamp >
    CONFIG.maxPriceAge
  ) {

    return false;
  }


  const desync =
    Math.abs(
      cb.timestamp -
      okx.timestamp
    );


  if (
    desync >
    CONFIG.maxPriceDesync
  ) {

    return false;
  }


  return true;
}


/* ============================================================
   ARBITRAGE CALCULATIONS
============================================================ */

function calculateCBtoOKX(cb, okx) {

  const okxBidUSD =
    okx.bid /
    CONFIG.usdToUsdt;


  const effectiveBuy =
    cb.ask *
    (
      1 +
      CONFIG.coinbaseSlippagePercent /
      100
    );


  const totalBuy =
    effectiveBuy *
    (
      1 +
      CONFIG.coinbaseFeePercent /
      100
    );


  const effectiveSell =
    okxBidUSD *
    (
      1 -
      CONFIG.okxSlippagePercent /
      100
    );


  const totalSell =
    effectiveSell *
    (
      1 -
      CONFIG.okxFeePercent /
      100
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

    buyPrice:
      totalBuy,

    sellPrice:
      totalSell
  };
}


function calculateOKXtoCB(cb, okx) {

  const okxAskUSD =
    okx.ask /
    CONFIG.usdToUsdt;


  const effectiveBuy =
    okxAskUSD *
    (
      1 +
      CONFIG.okxSlippagePercent /
      100
    );


  const totalBuy =
    effectiveBuy *
    (
      1 +
      CONFIG.okxFeePercent /
      100
    );


  const effectiveSell =
    cb.bid *
    (
      1 -
      CONFIG.coinbaseSlippagePercent /
      100
    );


  const totalSell =
    effectiveSell *
    (
      1 -
      CONFIG.coinbaseFeePercent /
      100
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

    buyPrice:
      totalBuy,

    sellPrice:
      totalSell
  };
}


/* ============================================================
   BREAK EVEN
============================================================ */

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
    ) -
    1
  ) * 100;
}


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
    ) -
    1
  ) * 100;
}


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


/* ============================================================
   CONFIRMATION ENGINE
============================================================ */

function resetConfirmation(
  symbol,
  direction
) {

  const confirmation =
    confirmations[symbol];


  if (
    direction ===
    "CB_OKX"
  ) {

    confirmation.cbToOkx =
      0;

    confirmation.lastCbToOkx =
      0;

    confirmation.notifiedCbToOkx =
      false;

  } else {

    confirmation.okxToCb =
      0;

    confirmation.lastOkxToCb =
      0;

    confirmation.notifiedOkxToCb =
      false;
  }
}


function updateConfirmation(
  symbol,
  direction,
  profitable
) {

  const confirmation =
    confirmations[symbol];

  const currentTime =
    Date.now();


  /*
   * Se non e' piu' profittevole,
   * azzeriamo immediatamente le conferme.
   */

  if (!profitable) {

    resetConfirmation(
      symbol,
      direction
    );

    return;
  }


  if (
    direction ===
    "CB_OKX"
  ) {

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

  } else {

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


/* ============================================================
   PAPER TRADE
============================================================ */

function executePaperTrade(
  symbol,
  buyExchange,
  buyPrice,
  sellExchange,
  sellPrice,
  grossPercent,
  netPercent
) {

  if (
    !CONFIG.paperTrading ||
    CONFIG.realOrdersEnabled
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
    tradeAmount > paper.capital
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


  const previousCapital =
    paper.capital;


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


  stats.executedOpportunities++;


  log(
    "============================================================"
  );


  log(
    "🚨 PAPER TRADE ESEGUITO"
  );


  log(
    `PAIR: ${symbol}`
  );


  log(
    `BUY:  ${buyExchange} @ ${buyPrice.toFixed(2)}`
  );


  log(
    `SELL: ${sellExchange} @ ${sellPrice.toFixed(2)}`
  );


  log(
    `SPREAD LORDO: ${pct(grossPercent)}`
  );


  log(
    `PROFITTO NETTO: ${pct(netPercent)}`
  );


  log(
    `CAPITALE OPERAZIONE: ${money(tradeAmount)}`
  );


  log(
    `PROFITTO: ${money(profit)}`
  );


  log(
    `CAPITALE PRIMA: ${money(previousCapital)}`
  );


  log(
    `CAPITALE DOPO: ${money(paper.capital)}`
  );


  log(
    `PROFITTO TOTALE: ${money(paper.totalProfit)}`
  );


  log(
    `OPERAZIONI TOTALI: ${paper.trades}`
  );


  log(
    "🔒 ORDINI REALI: DISABILITATI"
  );


  log(
    "============================================================"
  );


  notifyTelegram(

    `🚨 PAPER TRADE ESEGUITO\n\n` +

    `Pair: ${symbol}\n` +

    `BUY: ${buyExchange} @ ${buyPrice.toFixed(2)}\n` +

    `SELL: ${sellExchange} @ ${sellPrice.toFixed(2)}\n` +

    `Spread lordo: ${pct(grossPercent)}\n` +

    `Profitto netto: ${pct(netPercent)}\n` +

    `Capitale operazione: ${money(tradeAmount)}\n` +

    `Profitto: ${money(profit)}\n` +

    `Capitale dopo: ${money(paper.capital)}\n` +

    `Operazioni totali: ${paper.trades}\n` +

    `Opportunità confermate: ${stats.confirmedOpportunities}\n` +

    `Opportunità eseguite: ${stats.executedOpportunities}\n` +

    `🔒 Ordini reali: DISABILITATI`
  );


  return true;
}


/* ============================================================
   TELEGRAM OPPORTUNITY
============================================================ */

function notifyProfitableOpportunity(
  symbol,
  direction,
  result,
  confirmationCount
) {

  if (
    confirmationCount <
    CONFIG.requiredConfirmations
  ) {

    return;
  }


  if (
    !Number.isFinite(result.net) ||
    result.net <
    CONFIG.minNetProfitPercent
  ) {

    return;
  }


  const key =
    `${symbol}_${direction}`;


  const currentTime =
    Date.now();


  const lastSent =
    stats.lastTelegramOpportunity[key] ||
    0;


  if (
    currentTime -
    lastSent <
    CONFIG.telegramOpportunityCooldown
  ) {

    return;
  }


  stats.lastTelegramOpportunity[key] =
    currentTime;


  const buyExchange =
    direction ===
    "CB_OKX"
      ? "Coinbase"
      : "OKX";


  const sellExchange =
    direction ===
    "CB_OKX"
      ? "OKX"
      : "Coinbase";


  notifyTelegram(

    `🟢 OPPORTUNITÀ CONFERMATA ${symbol}\n\n` +

    `BUY: ${buyExchange} @ ${result.buyPrice.toFixed(2)}\n` +

    `SELL: ${sellExchange} @ ${result.sellPrice.toFixed(2)}\n` +

    `Spread lordo: ${pct(result.gross)}\n` +

    `Profitto netto stimato: ${pct(result.net)}\n` +

    `Conferme: ${confirmationCount}/${CONFIG.requiredConfirmations}\n` +

    `Soglia minima: ${pct(CONFIG.minNetProfitPercent)}\n\n` +

    `🟢 CONFERMATA\n` +

    `Modalità: PAPER TRADING\n` +

    `🔒 Ordini reali: DISABILITATI`
  );
}


/* ============================================================
   DISPLAY STATUS
============================================================ */

function displayStatus(
  symbol,
  cb,
  okx,
  result1,
  result2,
  target1,
  target2
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
        target1 -
        result1.gross
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
        target2 -
        result2.gross
      )
    )}`
  );


  console.log(
    `Break-even CB -> OKX: ${pct(
      calculateBreakEvenBuyCoinbaseSellOKX()
    )}`
  );


  console.log(
    `Break-even OKX -> CB: ${pct(
      calculateBreakEvenBuyOKXSellCoinbase()
    )}`
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
    `📈 Operazioni eseguite: ${paper.trades}`
  );


  console.log(
    `🎯 Opportunità attuali: ${stats.currentOpportunities}`
  );


  console.log(
    `✅ Opportunità confermate: ${stats.confirmedOpportunities}`
  );


  console.log(
    "------------------------------------------------------------"
  );
}


/* ============================================================
   ARBITRAGE CHECK
============================================================ */

function checkArbitrage(symbol) {

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


  const targetGross1 =
    targetGrossForNet(

      CONFIG.coinbaseFeePercent,

      CONFIG.coinbaseSlippagePercent,

      CONFIG.okxFeePercent,

      CONFIG.okxSlippagePercent
    );


  const targetGross2 =
    targetGrossForNet(

      CONFIG.okxFeePercent,

      CONFIG.okxSlippagePercent,

      CONFIG.coinbaseFeePercent,

      CONFIG.coinbaseSlippagePercent
    );


  const profitable1 =
    result1.net >=
    CONFIG.minNetProfitPercent;


  const profitable2 =
    result2.net >=
    CONFIG.minNetProfitPercent;


  /*
   * QUESTO E' IL CAMBIAMENTO PRINCIPALE.
   *
   * currentOpportunities NON viene incrementato ad ogni check.
   *
   * Vale:
   * 0 = nessuna opportunita' realmente profittevole
   * 1 = una direzione profittevole
   * 2 = entrambe profittevoli
   */

  stats.currentOpportunities = 0;


  if (
    profitable1
  ) {

    stats.currentOpportunities++;
  }


  if (
    profitable2
  ) {

    stats.currentOpportunities++;
  }


  /*
   * AGGIORNAMENTO DELLE CONFERME
   */

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


  const confirmation =
    confirmations[symbol];


  const confirmed1 =
    profitable1 &&
    confirmation.cbToOkx >=
    CONFIG.requiredConfirmations;


  const confirmed2 =
    profitable2 &&
    confirmation.okxToCb >=
    CONFIG.requiredConfirmations;


  /*
   * CONFERMA CB -> OKX
   */

  if (
    confirmed1 &&
    !confirmation.notifiedCbToOkx
  ) {

    confirmation.notifiedCbToOkx =
      true;


    stats.confirmedOpportunities++;


    notifyProfitableOpportunity(

      symbol,

      "CB_OKX",

      result1,

      confirmation.cbToOkx
    );
  }


  /*
   * CONFERMA OKX -> CB
   */

  if (
    confirmed2 &&
    !confirmation.notifiedOkxToCb
  ) {

    confirmation.notifiedOkxToCb =
      true;


    stats.confirmedOpportunities++;


    notifyProfitableOpportunity(

      symbol,

      "OKX_CB",

      result2,

      confirmation.okxToCb
    );
  }


  /*
   * ESECUZIONE PAPER
   */

  if (
    confirmed1
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


    if (
      executed
    ) {

      resetConfirmation(
        symbol,
        "CB_OKX"
      );
    }
  }


  if (
    confirmed2
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


    if (
      executed
    ) {

      resetConfirmation(
        symbol,
        "OKX_CB"
      );
    }
  }


  /*
   * LOG
   */

  const displayNow =
    Date.now();


  if (
    displayNow -
    stats.lastDisplayTime[symbol] >=
    1000
  ) {

    stats.lastDisplayTime[symbol] =
      displayNow;


    displayStatus(

      symbol,

      cb,

      okx,

      result1,

      result2,

      targetGross1,

      targetGross2
    );
  }
}


/* ============================================================
   COINBASE UPDATE
============================================================ */

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

      if (
        !ticker
      ) {

        continue;
      }


      const symbol =
        getPairByCoinbaseProduct(
          ticker.product_id
        );


      if (
        !symbol
      ) {

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
        validNumber(bid)
      ) {

        books[symbol]
          .coinbase
          .bid =
          bid;


        changed =
          true;
      }


      if (
        validNumber(ask)
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
          symbol
        );
      }
    }
  }
}


/* ============================================================
   CONNECT COINBASE
============================================================ */

function connectCoinbase() {

  if (
    connectionState.coinbase.ws &&
    connectionState.coinbase.ws.readyState ===
    WebSocket.OPEN
  ) {

    return;
  }


  const ws =
    new WebSocket(
      "wss://advanced-trade-ws.coinbase.com"
    );


  connectionState.coinbase.ws =
    ws;


  connectionState.coinbase.reconnecting =
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


        connectionState.coinbase.lastMessage =
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
        connectionState.coinbase.ws ===
        ws
      ) {

        connectionState.coinbase.ws =
          null;
      }


      if (
        connectionState.coinbase.reconnecting
      ) {

        return;
      }


      connectionState.coinbase.reconnecting =
        true;


      log(
        "🔴 Coinbase disconnesso."
      );


      notifyTelegram(
        "🔴 Coinbase DISCONNESSO\n\n🔄 Riconnessione automatica in corso..."
      );


      setTimeout(
        () => {

          connectionState.coinbase.reconnecting =
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


/* ============================================================
   OKX UPDATE
============================================================ */

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
    getPairByOKXProduct(
      data.arg.instId
    );


  if (
    !symbol
  ) {

    return;
  }


  const book =
    data.data?.[0];


  if (
    !book
  ) {

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
      validNumber(bid)
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
      validNumber(ask)
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
      symbol
    );
  }
}


/* ============================================================
   CONNECT OKX
============================================================ */

function connectOKX() {

  if (
    connectionState.okx.ws &&
    connectionState.okx.ws.readyState ===
    WebSocket.OPEN
  ) {

    return;
  }


  const ws =
    new WebSocket(
      "wss://ws.okx.com:8443/ws/v5/public"
    );


  connectionState.okx.ws =
    ws;


  connectionState.okx.reconnecting =
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


        connectionState.okx.lastMessage =
          Date.now();


        const text =
          raw.toString();


        if (
          text ===
          "ping"
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
          text ===
          "pong"
        ) {

          return;
        }


        const data =
          JSON.parse(
            text
          );


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
        connectionState.okx.ws ===
        ws
      ) {

        connectionState.okx.ws =
          null;
      }


      if (
        connectionState.okx.reconnecting
      ) {

        return;
      }


      connectionState.okx.reconnecting =
        true;


      log(
        "🔴 OKX disconnesso."
      );


      notifyTelegram(
        "🔴 OKX DISCONNESSO\n\n🔄 Riconnessione automatica in corso..."
      );


      setTimeout(
        () => {

          connectionState.okx.reconnecting =
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


/* ============================================================
   TELEGRAM STATUS
============================================================ */

function buildTelegramStatus() {

  const cbState =
    connectionState.coinbase.ws?.readyState ===
    WebSocket.OPEN
      ? "🟢 ONLINE"
      : "🔴 OFFLINE";


  const okxState =
    connectionState.okx.ws?.readyState ===
    WebSocket.OPEN
      ? "🟢 ONLINE"
      : "🔴 OFFLINE";


  const roi =
    paper.initialCapital > 0
      ? (
          paper.totalProfit /
          paper.initialCapital
        ) *
        100
      : 0;


  return (

    `📊 STATO BOT\n\n` +

    `Coinbase ${cbState}\n` +

    `OKX ${okxState}\n\n` +

    `💰 Capitale PAPER: ${money(paper.capital)}\n` +

    `💵 Profitto: ${money(paper.totalProfit)}\n` +

    `📈 ROI: ${pct(roi)}\n` +

    `📝 Operazioni: ${paper.trades}\n` +

    `🔎 Controlli: ${stats.checks}\n` +

    `🎯 Opportunità attuali: ${stats.currentOpportunities}\n` +

    `✅ Opportunità confermate: ${stats.confirmedOpportunities}\n` +

    `🚀 Opportunità eseguite: ${stats.executedOpportunities}\n\n` +

    `Soglia netta: ${CONFIG.minNetProfitPercent}%\n` +

    `Conferme richieste: ${CONFIG.requiredConfirmations}\n` +

    `Modalità: PAPER TRADING\n` +

    `🔒 Ordini reali: DISABILITATI`
  );
}


function sendTelegramStatus() {

  const currentTime =
    Date.now();


  if (
    currentTime -
    stats.lastTelegramStatus <
    CONFIG.statusInterval
  ) {

    return;
  }


  stats.lastTelegramStatus =
    currentTime;


  notifyTelegram(
    buildTelegramStatus()
  );
}


/* ============================================================
   PORTFOLIO REPORT
============================================================ */

function printPortfolio() {

  const roi =
    paper.initialCapital > 0

      ? (
          paper.totalProfit /
          paper.initialCapital
        ) *
        100

      : 0;


  log(
    "============================================================"
  );


  log(
    "💰 PAPER TRADING REPORT"
  );


  log(
    `Capitale iniziale: ${money(paper.initialCapital)}`
  );


  log(
    `Capitale attuale:  ${money(paper.capital)}`
  );


  log(
    `Profitto totale:   ${money(paper.totalProfit)}`
  );


  log(
    `ROI:               ${pct(roi)}`
  );


  log(
    `Operazioni:        ${paper.trades}`
  );


  log(
    `Vincenti:          ${paper.winningTrades}`
  );


  log(
    `Perdenti:          ${paper.losingTrades}`
  );


  log(
    `Volume PAPER:      ${money(paper.volume)}`
  );


  log(
    `Controlli mercato: ${stats.checks}`
  );


  log(
    `Opportunità attuali: ${stats.currentOpportunities}`
  );


  log(
    `Opportunità confermate: ${stats.confirmedOpportunities}`
  );


  log(
    `Opportunità eseguite: ${stats.executedOpportunities}`
  );


  log(
    `Coinbase messaggi: ${stats.coinbaseMessages}`
  );


  log(
    `Coinbase update:   ${stats.coinbaseUpdates}`
  );


  log(
    `OKX messaggi:      ${stats.okxMessages}`
  );


  log(
    `OKX update:        ${stats.okxUpdates}`
  );


  log(
    `Soglia netto: ${CONFIG.minNetProfitPercent}%`
  );


  log(
    `Conferme richieste: ${CONFIG.requiredConfirmations}`
  );


  log(
    `Trade: ${CONFIG.tradePercentOfCapital}% del capitale`
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
}


/* ============================================================
   START
============================================================ */

log(
  "============================================================"
);


log(
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE v13"
);


log(
  `💰 Capitale iniziale: ${money(CONFIG.initialCapital)}`
);


log(
  `🎯 Profitto netto minimo: ${CONFIG.minNetProfitPercent}%`
);


log(
  `🔁 Conferme richieste: ${CONFIG.requiredConfirmations}`
);


log(
  "🔒 ORDINI REALI: DISABILITATI"
);


log(
  "============================================================"
);


notifyTelegram(

  `🟢 CRYPTO ARBITRAGE BOT AVVIATO\n\n` +

  `Modalità: PAPER TRADING\n` +

  `Capitale: ${money(CONFIG.initialCapital)}\n` +

  `Coppie: BTC / ETH\n` +

  `Conferme richieste: ${CONFIG.requiredConfirmations}\n` +

  `Opportunità attuali: 0\n` +

  `Opportunità confermate: 0\n` +

  `Opportunità eseguite: 0\n` +

  `🔒 Ordini reali: DISABILITATI`
);


connectCoinbase();

connectOKX();


/* ============================================================
   CONTINUOUS SCANNER
============================================================ */

setInterval(
  () => {

    checkArbitrage(
      "BTC"
    );


    checkArbitrage(
      "ETH"
    );

  },

  CONFIG.marketScanInterval
);


/* ============================================================
   AUTOMATIC REPORT
============================================================ */

setInterval(
  printPortfolio,
  CONFIG.statusInterval
);


/* ============================================================
   TELEGRAM STATUS
============================================================ */

setInterval(
  sendTelegramStatus,
  1000
);


/* ============================================================
   MARKET DATA WATCHDOG
============================================================ */

setInterval(
  () => {

    const currentTime =
      Date.now();


    if (
      connectionState.coinbase.ws?.readyState ===
      WebSocket.OPEN &&

      connectionState.coinbase.lastMessage > 0 &&

      currentTime -
      connectionState.coinbase.lastMessage >
      CONFIG.marketDataTimeout
    ) {

      log(
        "⚠️ Coinbase silenzioso: riconnessione watchdog."
      );


      try {

        connectionState.coinbase.ws.close();

      } catch (error) {

        log(
          `⚠️ Errore chiusura Coinbase watchdog: ${error.message}`
        );
      }
    }


    if (
      connectionState.okx.ws?.readyState ===
      WebSocket.OPEN &&

      connectionState.okx.lastMessage > 0 &&

      currentTime -
      connectionState.okx.lastMessage >
      CONFIG.marketDataTimeout
    ) {

      log(
        "⚠️ OKX silenzioso: riconnessione watchdog."
      );


      try {

        connectionState.okx.ws.close();

      } catch (error) {

        log(
          `⚠️ Errore chiusura OKX watchdog: ${error.message}`
        );
      }
    }

  },

  CONFIG.marketDataWatchdogInterval
);


/* ============================================================
   LIVE STATUS
============================================================ */

setInterval(
  () => {

    const cbState =
      connectionState.coinbase.ws?.readyState ===
      WebSocket.OPEN
        ? "ONLINE"
        : "OFFLINE";


    const okxState =
      connectionState.okx.ws?.readyState ===
      WebSocket.OPEN
        ? "ONLINE"
        : "OFFLINE";


    log(

      `❤️ LIVE | ` +

      `Coinbase: ${cbState} | ` +

      `OKX: ${okxState} | ` +

      `Trades ${paper.trades} | ` +

      `Profitto ${money(paper.totalProfit)} | ` +

      `Opportunità attuali ${stats.currentOpportunities} | ` +

      `Confermate ${stats.confirmedOpportunities}`

    );

  },

  10000
);


/* ============================================================
   ERROR HANDLERS
============================================================ */

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
