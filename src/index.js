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
  usdToUsdt: 1,
  maxPriceAge: 2000,
  maxPriceDesync: 500,
  opportunityCooldown: 10000,
  reconnectDelay: 5000,
  marketScanInterval: 250,
  statusInterval: 30000,
  okxPingInterval: 20000,
  marketDataTimeout: 15000
};

const TELEGRAM_CHAT_ID = "1254274653";

const paper = {
  capital: CONFIG.initialCapital,
  initialCapital: CONFIG.initialCapital,
  totalProfit: 0,
  trades: 0,
  winningTrades: 0,
  losingTrades: 0,
  volume: 0,
  lastTrade: { BTC: 0, ETH: 0 }
};

const books = Object.fromEntries(
  Object.keys(CONFIG.pairs).map(symbol => [
    symbol,
    {
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
  ])
);

const confirmations = Object.fromEntries(
  Object.keys(CONFIG.pairs).map(symbol => [
    symbol,
    {
      CB_OKX: 0,
      OKX_CB: 0,
      lastCB_OKX: 0,
      lastOKX_CB: 0
    }
  ])
);

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

const stats = {
  checks: 0,
  opportunities: 0,
  profitable: 0,

  coinbaseMessages: 0,
  coinbaseUpdates: 0,

  okxMessages: 0,
  okxUpdates: 0,

  lastDisplay: {
    BTC: 0,
    ETH: 0
  },

  lastTelegram: {
    BTC_CB_OKX: 0,
    BTC_OKX_CB: 0,
    ETH_CB_OKX: 0,
    ETH_OKX_CB: 0
  }
};


function log(message) {
  console.log(
    `[${new Date().toLocaleTimeString("it-IT")}] ${message}`
  );
}


function money(value) {
  return `€${Number(value).toFixed(2)}`;
}


function pct(value) {
  return `${Number(value).toFixed(4)}%`;
}


function valid(value) {
  return Number.isFinite(value) && value > 0;
}


// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    log(
      "⚠️ Telegram: TELEGRAM_BOT_TOKEN non configurato."
    );

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
      log(
        `❌ Telegram HTTP ${response.status}: ${await response.text()}`
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


// ============================================================
// MARKET DATA
// ============================================================

function ready(symbol) {
  const book = books[symbol];

  return (
    valid(book.coinbase.bid) &&
    valid(book.coinbase.ask) &&
    valid(book.okx.bid) &&
    valid(book.okx.ask)
  );
}


function fresh(symbol) {
  const book = books[symbol];
  const currentTime = Date.now();

  const coinbaseAge =
    currentTime - book.coinbase.timestamp;

  const okxAge =
    currentTime - book.okx.timestamp;

  const desync =
    Math.abs(
      book.coinbase.timestamp -
      book.okx.timestamp
    );

  return (
    coinbaseAge <= CONFIG.maxPriceAge &&
    okxAge <= CONFIG.maxPriceAge &&
    desync <= CONFIG.maxPriceDesync
  );
}


// ============================================================
// ARBITRAGGIO COINBASE -> OKX
// ============================================================

function calcCBtoOKX(cb, okx) {
  const buyPrice =
    cb.ask *
    (1 + CONFIG.coinbaseSlippagePercent / 100) *
    (1 + CONFIG.coinbaseFeePercent / 100);

  const sellPrice =
    (okx.bid / CONFIG.usdToUsdt) *
    (1 - CONFIG.okxSlippagePercent / 100) *
    (1 - CONFIG.okxFeePercent / 100);

  const gross =
    (
      (
        okx.bid / CONFIG.usdToUsdt -
        cb.ask
      ) /
      cb.ask
    ) *
    100;

  const net =
    (
      (sellPrice - buyPrice) /
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
// ARBITRAGGIO OKX -> COINBASE
// ============================================================

function calcOKXtoCB(cb, okx) {
  const okxAskUSD =
    okx.ask / CONFIG.usdToUsdt;

  const buyPrice =
    okxAskUSD *
    (1 + CONFIG.okxSlippagePercent / 100) *
    (1 + CONFIG.okxFeePercent / 100);

  const sellPrice =
    cb.bid *
    (1 - CONFIG.coinbaseSlippagePercent / 100) *
    (1 - CONFIG.coinbaseFeePercent / 100);

  const gross =
    (
      (cb.bid - okxAskUSD) /
      okxAskUSD
    ) *
    100;

  const net =
    (
      (sellPrice - buyPrice) /
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
// BREAK EVEN
// ============================================================

function targetGross(
  buyFee,
  buySlip,
  sellFee,
  sellSlip
) {
  const buyFactor =
    (1 + buySlip / 100) *
    (1 + buyFee / 100);

  const sellFactor =
    (1 - sellSlip / 100) *
    (1 - sellFee / 100);

  return (
    (
      (
        1 +
        CONFIG.minNetProfitPercent / 100
      ) *
      buyFactor /
      sellFactor
    ) -
    1
  ) *
  100;
}


// ============================================================
// CONFERME
// ============================================================

function resetConfirmation(
  symbol,
  direction
) {
  confirmations[symbol][direction] = 0;

  confirmations[symbol][
    `last${direction}`
  ] = 0;
}


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

  const confirmation =
    confirmations[symbol];

  const currentTime =
    Date.now();

  const lastKey =
    `last${direction}`;

  if (
    !confirmation[lastKey] ||
    currentTime -
      confirmation[lastKey] >=
      CONFIG.confirmationInterval
  ) {
    confirmation[direction]++;

    confirmation[lastKey] =
      currentTime;
  }
}


// ============================================================
// TELEGRAM OPPORTUNITÀ
// ============================================================

function maybeAlert(
  symbol,
  direction,
  result
) {
  if (
    result.net <
    CONFIG.minNetProfitPercent
  ) {
    return;
  }

  const key =
    `${symbol}_${direction}`;

  const currentTime =
    Date.now();

  const lastAlert =
    stats.lastTelegram[key] || 0;

  if (
    currentTime - lastAlert <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  stats.lastTelegram[key] =
    currentTime;

  const confirmationCount =
    confirmations[symbol][direction];

  const tradeAmount =
    paper.capital *
    CONFIG.tradePercentOfCapital /
    100;

  const estimatedProfit =
    tradeAmount *
    result.net /
    100;

  const buyExchange =
    direction === "CB_OKX"
      ? "Coinbase"
      : "OKX";

  const sellExchange =
    direction === "CB_OKX"
      ? "OKX"
      : "Coinbase";

  notifyTelegram(
    `🚨 OPPORTUNITÀ ARBITRAGGIO\n\n` +
    `Pair: ${symbol}\n` +
    `BUY: ${buyExchange} @ ${result.buyPrice.toFixed(2)}\n` +
    `SELL: ${sellExchange} @ ${result.sellPrice.toFixed(2)}\n` +
    `Spread lordo: ${pct(result.gross)}\n` +
    `Profitto netto: ${pct(result.net)}\n` +
    `Conferma: ${confirmationCount}/${CONFIG.requiredConfirmations}\n` +
    `Capitale operazione: ${money(tradeAmount)}\n` +
    `Profitto stimato: ${money(estimatedProfit)}\n\n` +
    `⚠️ PAPER TRADING - nessun ordine reale`
  );
}


// ============================================================
// PAPER TRADE
// ============================================================

function executePaperTrade(
  symbol,
  direction,
  result
) {
  const confirmationCount =
    confirmations[symbol][direction];

  if (
    confirmationCount <
    CONFIG.requiredConfirmations
  ) {
    return;
  }

  const currentTime =
    Date.now();

  if (
    currentTime -
      paper.lastTrade[symbol] <
    CONFIG.opportunityCooldown
  ) {
    return;
  }

  const tradeAmount =
    paper.capital *
    CONFIG.tradePercentOfCapital /
    100;

  const profit =
    tradeAmount *
    result.net /
    100;

  if (profit <= 0) {
    return;
  }

  paper.capital += profit;

  paper.totalProfit += profit;

  paper.trades++;

  paper.winningTrades++;

  paper.volume +=
    tradeAmount;

  paper.lastTrade[symbol] =
    currentTime;

  stats.profitable++;

  log(
    `💰 PAPER TRADE ${symbol} ${direction} | ` +
    `profitto ${money(profit)} | ` +
    `capitale ${money(paper.capital)}`
  );

  notifyTelegram(
    `💰 PAPER TRADE ESEGUITO\n\n` +
    `Pair: ${symbol}\n` +
    `Direzione: ${direction}\n` +
    `Profitto: ${money(profit)}\n` +
    `Capitale: ${money(paper.capital)}\n\n` +
    `⚠️ Nessun ordine reale`
  );
}


// ============================================================
// CONTROLLO ARBITRAGGIO
// ============================================================

function checkArbitrage(
  symbol,
  display = true
) {
  stats.checks++;

  if (
    !ready(symbol) ||
    !fresh(symbol)
  ) {
    return;
  }

  const cb =
    books[symbol].coinbase;

  const okx =
    books[symbol].okx;

  const cbToOkx =
    calcCBtoOKX(
      cb,
      okx
    );

  const okxToCb =
    calcOKXtoCB(
      cb,
      okx
    );

  const targetCB =
    targetGross(
      CONFIG.coinbaseFeePercent,
      CONFIG.coinbaseSlippagePercent,
      CONFIG.okxFeePercent,
      CONFIG.okxSlippagePercent
    );

  const targetOKX =
    targetGross(
      CONFIG.okxFeePercent,
      CONFIG.okxSlippagePercent,
      CONFIG.coinbaseFeePercent,
      CONFIG.coinbaseSlippagePercent
    );

  const profitableCB =
    cbToOkx.net >=
    CONFIG.minNetProfitPercent;

  const profitableOKX =
    okxToCb.net >=
    CONFIG.minNetProfitPercent;

  if (
    cbToOkx.gross > 0 ||
    okxToCb.gross > 0
  ) {
    stats.opportunities++;
  }

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
    maybeAlert(
      symbol,
      "CB_OKX",
      cbToOkx
    );

    executePaperTrade(
      symbol,
      "CB_OKX",
      cbToOkx
    );
  }

  if (profitableOKX) {
    maybeAlert(
      symbol,
      "OKX_CB",
      okxToCb
    );

    executePaperTrade(
      symbol,
      "OKX_CB",
      okxToCb
    );
  }

  const currentTime =
    Date.now();

  if (
    display &&
    currentTime -
      stats.lastDisplay[symbol] >=
      1000
  ) {
    stats.lastDisplay[symbol] =
      currentTime;

    log(
      `📊 ${symbol} | ` +
      `CB BID/ASK ${cb.bid.toFixed(2)}/${cb.ask.toFixed(2)} | ` +
      `OKX BID/ASK ${okx.bid.toFixed(2)}/${okx.ask.toFixed(2)} | ` +
      `CB→OKX lordo ${pct(cbToOkx.gross)} netto ${pct(cbToOkx.net)} | ` +
      `OKX→CB lordo ${pct(okxToCb.gross)} netto ${pct(okxToCb.net)} | ` +
      `target ${pct(targetCB)}/${pct(targetOKX)} | ` +
      `conf ${confirmations[symbol].CB_OKX}/${confirmations[symbol].OKX_CB}`
    );
  }
}


// ============================================================
// COINBASE
// ============================================================

function updateCoinbase(
  message
) {
  if (
    !message ||
    message.type !== "ticker" ||
    !message.product_id
  ) {
    return;
  }

  const symbol =
    Object.keys(CONFIG.pairs)
      .find(
        s =>
          CONFIG.pairs[s].coinbase ===
          message.product_id
      );

  if (!symbol) {
    return;
  }

  const bid =
    Number(message.best_bid);

  const ask =
    Number(message.best_ask);

  if (
    !valid(bid) ||
    !valid(ask)
  ) {
    return;
  }

  books[symbol].coinbase = {
    bid,
    ask,
    timestamp: Date.now()
  };

  stats.coinbaseUpdates++;
}


function connectCoinbase() {
  const ws =
    new WebSocket(
      "wss://ws-feed.exchange.coinbase.com"
    );

  state.coinbase.ws =
    ws;

  ws.on(
    "open",
    () => {
      log(
        "🟢 Coinbase WebSocket CONNECTED"
      );

      ws.send(
        JSON.stringify({
          type: "subscribe",

          product_ids:
            Object.values(
              CONFIG.pairs
            ).map(
              pair =>
                pair.coinbase
            ),

          channels: [
            "ticker"
          ]
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

      state.coinbase.lastMessage =
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
      reconnect(
        "coinbase"
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
// OKX
// ============================================================

function updateOKX(
  message
) {
  if (
    !message ||
    !message.arg ||
    !message.data ||
    !message.data[0]
  ) {
    return;
  }

  const symbol =
    Object.keys(CONFIG.pairs)
      .find(
        s =>
          CONFIG.pairs[s].okx ===
          message.arg.instId
      );

  if (!symbol) {
    return;
  }

  const item =
    message.data[0];

  const bid =
    Number(item.bidPx);

  const ask =
    Number(item.askPx);

  if (
    !valid(bid) ||
    !valid(ask)
  ) {
    return;
  }

  books[symbol].okx = {
    bid,
    ask,
    timestamp: Date.now()
  };

  stats.okxUpdates++;
}


function connectOKX() {
  const ws =
    new WebSocket(
      "wss://ws.okx.com:8443/ws/v5/public"
    );

  state.okx.ws =
    ws;

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

          args:
            Object.values(
              CONFIG.pairs
            ).map(
              pair => ({
                channel: "bbo-tbt",
                instId: pair.okx
              })
            )
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

      state.okx.lastMessage =
        Date.now();

      const text =
        raw.toString();

      if (
        text === "pong"
      ) {
        return;
      }

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

      try {
        updateOKX(
          JSON.parse(text)
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
      if (pingTimer) {
        clearInterval(
          pingTimer
        );
      }

      reconnect(
        "okx"
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
// RICONNESSIONE
// ============================================================

function reconnect(
  exchange
) {
  if (
    state[exchange].reconnecting
  ) {
    return;
  }

  state[exchange].reconnecting =
    true;

  log(
    `🔴 ${exchange} disconnesso. ` +
    `Riconnessione in ${CONFIG.reconnectDelay} ms...`
  );

  notifyTelegram(
    `🔴 ${exchange.toUpperCase()} DISCONNESSO\n\n` +
    `🔄 Riconnessione automatica in corso...`
  );

  setTimeout(
    () => {
      state[exchange].reconnecting =
        false;

      if (
        exchange ===
        "coinbase"
      ) {
        connectCoinbase();
      } else {
        connectOKX();
      }
    },
    CONFIG.reconnectDelay
  );
}


// ============================================================
// REPORT
// ============================================================

function printPortfolio() {
  const roi =
    paper.totalProfit /
    paper.initialCapital *
    100;

  log(
    `💰 PAPER | ` +
    `capitale ${money(paper.capital)} | ` +
    `profitto ${money(paper.totalProfit)} | ` +
    `ROI ${pct(roi)} | ` +
    `operazioni ${paper.trades} | ` +
    `checks ${stats.checks} | ` +
    `CB msg/update ${stats.coinbaseMessages}/${stats.coinbaseUpdates} | ` +
    `OKX msg/update ${stats.okxMessages}/${stats.okxUpdates}`
  );
}


// ============================================================
// AVVIO
// ============================================================

log(
  "============================================================"
);

log(
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE"
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
  `🔒 Ordini reali: DISABILITATI`
);


connectCoinbase();

connectOKX();


// ============================================================
// SCANNER CONTINUO
// ============================================================

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


// ============================================================
// REPORT AUTOMATICO
// ============================================================

setInterval(
  printPortfolio,
  CONFIG.statusInterval
);


// ============================================================
// WATCHDOG
// ============================================================

setInterval(
  () => {
    const currentTime =
      Date.now();

    for (
      const exchange of [
        "coinbase",
        "okx"
      ]
    ) {
      const connection =
        state[exchange];

      if (
        connection.ws &&
        connection.ws.readyState ===
        WebSocket.OPEN &&
        connection.lastMessage &&
        currentTime -
          connection.lastMessage >
          CONFIG.marketDataTimeout
      ) {
        log(
          `⚠️ ${exchange} silenzioso: ` +
          `watchdog, riconnessione.`
        );

        try {
          connection.ws.close();
        } catch (_) {}
      }
    }
  },
  10000
);


// ============================================================
// HEARTBEAT
// ============================================================

setInterval(
  () => {
    const coinbase =
      state.coinbase.ws?.readyState ===
      WebSocket.OPEN
        ? "ONLINE"
        : "OFFLINE";

    const okx =
      state.okx.ws?.readyState ===
      WebSocket.OPEN
        ? "ONLINE"
        : "OFFLINE";

    log(
      `❤️ LIVE | ` +
      `Coinbase ${coinbase} | ` +
      `OKX ${okx} | ` +
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
