import { checkZkappTransaction } from "o1js";

export async function txStatus(params: {
  hash: string;
  time: number;
  chain: string;
}): Promise<string> {
  const { hash, chain, time } = params;

  if (chain === "mainnet" || chain === "devnet") {
    try {
      const tx = await checkZkappTransaction(hash);
      if (tx?.success) return "applied";
    } catch (error) {}
    const tx = await getZkAppTxFromBlockberry({ hash, chain });
    if (tx?.txStatus) return tx?.txStatus;

    if (Date.now() - time > 1000 * 60 * 120) {
      console.error(
        "txStatus: Timeout while checking tx with blockberry",
        chain,
        hash
      );
      return "replaced";
    } else {
      return "pending";
    }
  } else {
    try {
      const tx = await checkZkappTransaction(hash);
      if (tx?.success) return "applied";
      if (Date.now() - time > 1000 * 60 * 120) {
        console.error("txStatus: Timeout while checking tx", chain, hash);
        return "replaced";
      } else {
        return "pending";
      }
    } catch (error) {
      console.error("txStatus: error while checking hash", chain, hash, error);
      return "replaced";
    }
  }
}

async function getZkAppTxFromBlockberry(params: {
  hash: string;
  chain: string;
}): Promise<any> {
  const { hash, chain } = params;
  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": process.env.BLOCKBERRY_API!,
    },
  };
  try {
    const response = await fetch(
      `https://api.blockberry.one/mina-${chain}/v1/zkapps/txs/${hash}`,
      options
    );
    if (response.ok) {
      const result = await response.json();
      return result;
    } else {
      console.warn(
        `getZkAppTxFromBlockberry error while getting ${chain} hash - not ok`,
        { hash, text: response.statusText, status: response.status }
      );
      return undefined;
    }
  } catch (err) {
    console.error(
      `getZkAppTxFromBlockberry error while getting ${chain} hash - catch`,
      hash,
      err
    );
    return undefined;
  }
}
