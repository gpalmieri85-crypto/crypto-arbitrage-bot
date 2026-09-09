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

  selfTestEnabled: true,

  telegramOpportunityCooldown: 30000
};

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

const stats = {
  coinbaseMessages: 0,
  coinbaseUpdates: 0,

  okxMessages: 0,
  okxUpdates: 0,

  checks: 0,
  opportunities: 0,
  profitableOpportunities: 0,

  lastDisplayTime: {
    BTC: 0,
    ETH: 0
  },

  lastOpportunity: null,

  lastTelegramOpportunity: {
    BTC_CB_OKX: 0,
    BTC_OKX_CB: 0,
    ETH_CB_OKX: 0,
    ETH_OKX_CB: 0
  }
};

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

const TELEGRAM_CHAT_ID = "1254274653";

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    log(
      "⚠️ Telegram: Secret TELEGRAM_BOT_TOKEN non trovato."
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
      const body = await response.text();

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
      "❌ Telegram error: " +
      error.message
    );

    return false;
  }
}

function notifyTelegram(message) {
  sendTelegram(message)
    .catch(error => {
      log(
        "❌ Telegram promise error: " +
        error.message
      );
    });
}

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

function pricesFresh(symbol) {
  const cb = books[symbol].coinbase;
  const okx = books[symbol].okx;

  const currentTime = Date.now();

  const cbAge =
    currentTime - cb.timestamp;

  const okxAge =
    currentTime - okx.timestamp;

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

function calculateCBtoOKX(
  cb,
  okx
) {
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
    buyPrice: totalBuy,
    sellPrice: totalSell
  };
}

function calculateOKXtoCB(
  cb,
  okx
) {
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
    buyPrice: totalBuy,
    sellPrice: totalSell
  };
}

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

    return;
  }

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

function notifyProfitableOpportunity(
  symbol,
  direction,
  result,
  confirmationCount
) {
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
    direction === "CB_OKX"
      ? "Coinbase"
      : "OKX";

  const sellExchange =
    direction === "CB_OKX"
      ? "OKX"
      : "Coinbase";

  notifyTelegram(
    `🚨 OPPORTUNITÀ ARBITRAGGIO ${symbol}\n\n` +
    `BUY: ${buyExchange} @ ${result.buyPrice.toFixed(2)}\n` +
    `SELL: ${sellExchange} @ ${result.sellPrice.toFixed(2)}\n` +
    `Spread lordo: ${pct(result.gross)}\n` +
    `Profitto netto stimato: ${pct(result.net)}\n` +
    `Conferme: ${confirmationCount}/${CONFIG.requiredConfirmations}\n` +
    `Soglia minima: ${pct(CONFIG.minNetProfitPercent)}\n` +
    `${confirmationCount >= CONFIG.requiredConfirmations ? "🟢 CONFERMATA" : "🟡 IN OSSERVAZIONE"}\n` +
    `Modalità: PAPER TRADING\n` +
    `🔒 Ordini reali: DISABILITATI`
  );
}

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
    `📈 Operazioni: ${paper.trades}`
  );

  console.log(
    "------------------------------------------------------------"
  );
}

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
    !CONFIG.paperTrading
  ) {
    return;
  }

  if (
    CONFIG.realOrdersEnabled
  ) {
    log(
      "❌ BLOCCO SICUREZZA: ordini reali disabilitati."
    );

    return;
  }

  if (
    !Number.isFinite(netPercent) ||
    netPercent <
    CONFIG.minNetProfitPercent
  ) {
    return;
  }

  const currentTime =
    Date.now();

  if (
    currentTime -
    paper.lastTradeTime[symbol] <
    CONFIG.opportunityCooldown
  ) {
    return;
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
    log(
      "⚠️ Capitale PAPER insufficiente"
    );

    return;
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
    return;
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

  stats.lastOpportunity = {
    symbol,
    buyExchange,
    sellExchange,
    grossPercent,
    netPercent,
    profit,
    timestamp: currentTime
  };

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
    `🔒 Ordini reali: DISABILITATI`
  );
}

function runPaperSelfTest() {
  if (
    !CONFIG.selfTestEnabled
  ) {
    return;
  }

  if (
    !CONFIG.paperTrading ||
    CONFIG.realOrdersEnabled
  ) {
    log(
      "⚠️ SELF TEST annullato: configurazione PAPER non sicura."
    );

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

    lastTradeTime: {
      BTC:
        paper.lastTradeTime.BTC,

      ETH:
        paper.lastTradeTime.ETH
    },

    confirmations: {
      ...confirmations.BTC
    }
  };

  const testNet =
    Math.max(
      CONFIG.minNetProfitPercent +
      0.20,
      0.50
    );

  const testGross =
    testNet +
    0.90;

  try {
    log(
      "🧪 SELF TEST PAPER: avvio verifica 3 conferme..."
    );

    confirmations.BTC.cbToOkx =
      0;

    confirmations.BTC.lastCbToOkx =
      0;

    for (
      let i = 0;
      i <
      CONFIG.requiredConfirmations;
      i++
    ) {
      confirmations.BTC.cbToOkx++;

      console.log(
        `🧪 Conferma test CB -> OKX: ${confirmations.BTC.cbToOkx}/${CONFIG.requiredConfirmations}`
      );
    }

    if (
      confirmations.BTC.cbToOkx >=
      CONFIG.requiredConfirmations
    ) {
      executePaperTrade(
        "BTC",
        "Coinbase",
        78000,
        "OKX",
        78500,
        testGross,
        testNet
      );

      log(
        "✅ SELF TEST PAPER COMPLETATO: conferme e PAPER TRADE funzionano."
      );
    }

  } catch (
    error
  ) {
    log(
      "❌ SELF TEST PAPER FALLITO: " +
      error.message
    );

  } finally {
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

    paper.lastTradeTime.BTC =
      saved.lastTradeTime.BTC;

    paper.lastTradeTime.ETH =
      saved.lastTradeTime.ETH;

    Object.assign(
      confirmations.BTC,
      saved.confirmations
    );

    log(
      "🔄 SELF TEST: dati PAPER ripristinati."
    );
  }
}

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

    if (
      profitable1
    ) {
      notifyProfitableOpportunity(
        symbol,
        "CB_OKX",
        result1,
        confirmations[symbol].cbToOkx
      );
    }

    if (
      profitable2
    ) {
      notifyProfitableOpportunity(
        symbol,
        "OKX_CB",
        result2,
        confirmations[symbol].okxToCb
      );
    }
  }

  stats.opportunities++;

  if (
    profitable1
  ) {
    stats.profitableOpportunities++;
  }

  if (
    profitable2
  ) {
    stats.profitableOpportunities++;
  }

  const displayNow =
    Date.now();

  if (
    displayNow -
    stats.lastDisplayTime[symbol] >=
    CONFIG.displayCooldown
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

  if (
    allowConfirmation &&
    profitable1 &&
    confirmations[symbol].cbToOkx >=
    CONFIG.requiredConfirmations
  ) {
    executePaperTrade(
      symbol,
      "Coinbase",
      cb.ask,
      "OKX",
      okx.bid,
      result1.gross,
      result1.net
    );

    confirmations[symbol].cbToOkx =
      0;

    confirmations[symbol].lastCbToOkx =
      0;
  }

  if (
    allowConfirmation &&
    profitable2 &&
    confirmations[symbol].okxToCb >=
    CONFIG.requiredConfirmations
  ) {
    executePaperTrade(
      symbol,
      "OKX",
      okx.ask,
      "Coinbase",
      cb.bid,
      result2.gross,
      result2.net
    );

    confirmations[symbol].okxToCb =
      0;

    confirmations[symbol].lastOkxToCb =
      0;
  }
}

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
        getPairByCoinbaseProduct(
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
          symbol,
          true
        );
      }
    }
  }
}

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

      } catch (
        error
      ) {
        log(
          "❌ Errore Coinbase: " +
          error.message
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

      log(
        "🔄 Riconnessione Coinbase..."
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
        "❌ Coinbase WebSocket error: " +
        error.message
      );
    }
  );
}

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
      symbol,
      true
    );
  }
}

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

      } catch (
        error
      ) {
        log(
          "❌ Errore OKX: " +
          error.message
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

      log(
        "🔄 Riconnessione OKX..."
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
        "❌ OKX WebSocket error: " +
        error.message
      );
    }
  );
}

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

  console.log("");

  console.log(
    `Soglia netto: ${
      CONFIG.minNetProfitPercent
    }%`
  );

  console.log(
    `Conferme richieste: ${
      CONFIG.requiredConfirmations
    }`
  );

  console.log(
    `Trade: ${
      CONFIG.tradePercentOfCapital
    }% del capitale`
  );

  console.log(
    `Commissione Coinbase: ${
      CONFIG.coinbaseFeePercent
    }%`
  );

  console.log(
    `Commissione OKX: ${
      CONFIG.okxFeePercent
    }%`
  );

  console.log(
    `Slippage Coinbase: ${
      CONFIG.coinbaseSlippagePercent
    }%`
  );

  console.log(
    `Slippage OKX: ${
      CONFIG.okxSlippagePercent
    }%`
  );

  console.log(
    `Scanner continuo: ogni ${
      CONFIG.marketScanInterval
    } ms`
  );

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

  console.log(
    "🔒 ORDINI REALI: DISABILITATI"
  );

  console.log(
    "============================================================"
  );
}

log(
  "============================================================"
);

log(
  "🚀 CRYPTO ARBITRAGE PAPER ENGINE v11"
);

notifyTelegram(
  `🟢 CRYPTO ARBITRAGE PAPER ENGINE AVVIATO\n\n` +
  `Modalità: PAPER TRADING\n` +
  `Capitale iniziale: ${money(CONFIG.initialCapital)}\n` +
  `Coppie: BTC / ETH\n` +
  `🔒 Ordini reali: DISABILITATI`
);

log(
  "============================================================"
);

log(
  "Modalità: PAPER TRADING"
);

log(
  `Capitale iniziale: ${
    money(CONFIG.initialCapital)
  }`
);

log(
  `Trade: ${
    CONFIG.tradePercentOfCapital
  }%`
);

log(
  `Profitto netto minimo: ${
    CONFIG.minNetProfitPercent
  }%`
);

log(
  `Conferme richieste: ${
    CONFIG.requiredConfirmations
  }`
);

log(
  `Intervallo conferme: ${
    CONFIG.confirmationInterval
  } ms`
);

log(
  `Commissione Coinbase: ${
    CONFIG.coinbaseFeePercent
  }%`
);

log(
  `Commissione OKX: ${
    CONFIG.okxFeePercent
  }%`
);

log(
  `Slippage Coinbase: ${
    CONFIG.coinbaseSlippagePercent
  }%`
);

log(
  `Slippage OKX: ${
    CONFIG.okxSlippagePercent
  }%`
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
  `Scanner continuo: ogni ${
    CONFIG.marketScanInterval
  } ms`
);

log(
  `Watchdog dati mercato: ogni ${
    CONFIG.marketDataWatchdogInterval
  } ms | timeout ${
    CONFIG.marketDataTimeout
  } ms`
);

log(
  "🔒 ORDINI REALI: DISABILITATI"
);

log(
  "============================================================"
);

connectCoinbase();

connectOKX();

setInterval(
  printPortfolio,
  CONFIG.statusInterval
);

setTimeout(
  runPaperSelfTest,
  3000
);

setInterval(
  () => {
    checkArbitrage(
      "BTC",
      true
    );

    checkArbitrage(
      "ETH",
      true
    );
  },
  CONFIG.marketScanInterval
);

setInterval(
  () => {
    const currentTime =
      Date.now();

    if (
      connectionState.coinbase.ws &&
      connectionState.coinbase.ws.readyState ===
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
      } catch (
        error
      ) {
        log(
          "⚠️ Errore chiusura Coinbase watchdog: " +
          error.message
        );
      }
    }

    if (
      connectionState.okx.ws &&
      connectionState.okx.ws.readyState ===
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
      } catch (
        error
      ) {
        log(
          "⚠️ Errore chiusura OKX watchdog: " +
          error.message
        );
      }
    }

  },
  CONFIG.marketDataWatchdogInterval
);

setInterval(
  () => {
    const currentTime =
      Date.now();

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

    const cbAge =
      connectionState.coinbase.lastMessage > 0
        ? currentTime -
          connectionState.coinbase.lastMessage
        : -1;

    const okxAge =
      connectionState.okx.lastMessage > 0
        ? currentTime -
          connectionState.okx.lastMessage
        : -1;

    console.log(
      `[${now()}] ❤️ LIVE | ` +
      `Coinbase: ${cbState} | ` +
      `OKX: ${okxState} | ` +
      `CB msg age: ${
        cbAge >= 0
          ? cbAge + "ms"
          : "n/a"
      } | ` +
      `OKX msg age: ${
        okxAge >= 0
          ? okxAge + "ms"
          : "n/a"
      } | ` +
      `Checks: ${stats.checks} | ` +
      `Updates: CB ${stats.coinbaseUpdates} / OKX ${stats.okxUpdates} | ` +
      `Trades: ${paper.trades}`
    );

  },
  10000
);

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
