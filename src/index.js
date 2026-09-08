const WebSocket = require("ws");

const CONFIG = {
  symbols: ["BTC-USDT", "ETH-USDT"],
  minNetProfitPercent: 0.10,
  reconnectDelay: 5000
};

const books = {
  coinbase: {},
  okx: {}
};

function now() {
  return new Date().toLocaleTimeString("it-IT");
}

function log(message) {
  console.log(`[${now()}] ${message}`);
}

function updateCoinbase(data) {
  if (!data.events) return;

  for (const event of data.events) {
    if (event.type !== "update") continue;

    for (const update of event.updates || []) {
      const product = update.product_id;

      if (!CONFIG.symbols.includes(product)) continue;

      if (!books.coinbase[product]) {
        books.coinbase[product] = {};
      }

      const side = update.side;

      if (side === "bid") {
        books.coinbase[product].bid = Number(update.price);
      }

      if (side === "offer") {
        books.coinbase[product].ask = Number(update.price);
      }

      checkArbitrage(product);
    }
  }
}

function connectCoinbase() {
  const ws = new WebSocket(
    "wss://advanced-trade-ws.coinbase.com"
  );

  ws.on("open", () => {
    log("Coinbase WebSocket CONNECTED");

    ws.send(
      JSON.stringify({
        type: "subscribe",
        product_ids: CONFIG.symbols,
        channel: "level2"
      })
    );
  });

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
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

function updateOKX(data) {
  if (!data.arg || data.arg.channel !== "books5") return;

  const instId = data.arg.instId;

  if (!CONFIG.symbols.includes(instId.replace("-", "-"))) return;

  const book = data.data?.[0];

  if (!book) return;

  if (!books.okx[instId]) {
    books.okx[instId] = {};
  }

  if (book.bids?.length) {
    books.okx[instId].bid = Number(book.bids[0][0]);
  }

  if (book.asks?.length) {
    books.okx[instId].ask = Number(book.asks[0][0]);
  }

  checkArbitrage(instId);
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
        args: CONFIG.symbols.map((symbol) => ({
          channel: "books5",
          instId: symbol
        }))
      })
    );
  });

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === "subscribe") return;

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

function checkArbitrage(symbol) {
  const cb = books.coinbase[symbol];
  const okx = books.okx[symbol];

  if (!cb || !okx) return;

  if (!cb.bid || !cb.ask || !okx.bid || !okx.ask) return;

  const opportunity1 =
    ((okx.bid - cb.ask) / cb.ask) * 100;

  const opportunity2 =
    ((cb.bid - okx.ask) / okx.ask) * 100;

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

function reportOpportunity(
  symbol,
  buyExchange,
  buyPrice,
  sellExchange,
  sellPrice,
  spread
) {
  console.log("");
  console.log("========================================");
  console.log("🚨 ARBITRAGE OPPORTUNITY");
  console.log("========================================");
  console.log(`PAIR: ${symbol}`);
  console.log(`BUY:  ${buyExchange} @ ${buyPrice}`);
  console.log(`SELL: ${sellExchange} @ ${sellPrice}`);
  console.log(`GROSS SPREAD: ${spread.toFixed(4)}%`);
  console.log("STATUS: PAPER TRADING ONLY");
  console.log("========================================");
  console.log("");
}

log("Crypto Arbitrage Scanner avviato");
log("Modalità: PAPER TRADING");
log("Capitale reale: €0");
log("Coppie: BTC-USDT, ETH-USDT");

connectCoinbase();
connectOKX();
