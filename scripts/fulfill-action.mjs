/** Autonomous order fulfilment for WhiskeyLog — GitHub Action on new issue.
 *  Verifies USDC-on-Base payment, signs a Pro license, posts it, records tx, closes. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const E = process.env;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const num = E.ISSUE_NUMBER, repo = E.REPO, body = E.ISSUE_BODY || "";
const sh = (c) => execSync(c, { stdio: ["ignore", "inherit", "inherit"] });
const comment = (m) => sh(`gh issue comment ${num} --repo ${repo} --body ${JSON.stringify(m)}`);

const txm = body.match(/0x[0-9a-fA-F]{64}/);
if (!txm) { comment("I couldn't find a payment transaction hash (0x… 64 hex). Edit the issue to include it and I'll verify automatically."); process.exit(0); }
const tx = txm[0].toLowerCase();
const email = (body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || ["buyer"])[0];

let redeemed = existsSync("redeemed.json") ? JSON.parse(readFileSync("redeemed.json")) : [];
if (redeemed.includes(tx)) { comment("This transaction was already redeemed."); process.exit(0); }

const rpc = async (method, params) => {
  const r = await fetch(E.CHAIN_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
};
const receipt = await rpc("eth_getTransactionReceipt", [tx]);
if (!receipt) { comment("That transaction isn't confirmed yet. Wait ~1 confirmation on Base, then **edit this issue** to re-run."); process.exit(0); }
if (receipt.status !== "0x1") { comment("That transaction failed on-chain — no license issued."); process.exit(0); }

const min = BigInt(E.PRICE_USDC) * (10n ** BigInt(E.USDC_DECIMALS || "6"));
let paid = false;
for (const log of receipt.logs || []) {
  if (log.address.toLowerCase() !== E.USDC_ADDR.toLowerCase()) continue;
  if ((log.topics[0] || "").toLowerCase() !== TRANSFER) continue;
  const to = "0x" + log.topics[2].slice(26).toLowerCase();
  if (to === E.WALLET.toLowerCase() && BigInt(log.data) >= min) { paid = true; break; }
}
if (!paid) { comment(`I couldn't find a payment of **${E.PRICE_USDC} USDC** to the seller wallet on **Base** in that transaction. Check the tx hash + network, then edit to retry.`); process.exit(0); }

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const key = await crypto.subtle.importKey("jwk", JSON.parse(E.LICENSE_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const payload = { email, plan: "pro", iat: Math.floor(Date.now() / 1000), tx };
const pb = new TextEncoder().encode(JSON.stringify(payload));
const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, pb);
const license = b64url(pb) + "." + b64url(sig);

comment(["✅ **Payment verified — your WhiskeyLog Pro license:**", "", "Open WhiskeyLog → **Pro** → *Have a key?* → paste:", "", "```", license, "```", "", "Lifetime, works offline. Slàinte! 🥃"].join("\n"));
redeemed.push(tx); writeFileSync("redeemed.json", JSON.stringify(redeemed, null, 2));
try {
  sh('git config user.name "github-actions[bot]"');
  sh('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  sh('git add redeemed.json && git commit -m "record redeemed tx" && git push');
} catch (e) { console.log("ledger commit skipped:", e.message); }
sh(`gh issue close ${num} --repo ${repo}`);
console.log("fulfilled", tx, email);
