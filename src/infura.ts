export async function pinToInfura(hash: string) {
  try {
    const url = process.env.INFURA_URL + "/api/v0/pin/add?arg=" + hash;
    const authorization =
      "Basic " +
      Buffer.from(
        process.env.INFURA_IPFS_KEY + ":" + process.env.INFURA_IPFS_SECRET
      ).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization,
      },
    });
    return await response.json();
  } catch (error: any) {
    console.error("pinToInfura error:", error?.message ?? error);
    return undefined;
  }
}

export async function getInfuraPin(hash: string) {
  try {
    const url = process.env.INFURA_URL + "/api/v0/pin/ls?arg=" + hash;
    const authorization =
      "Basic " +
      Buffer.from(
        process.env.INFURA_IPFS_KEY + ":" + process.env.INFURA_IPFS_SECRET
      ).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization,
      },
    });
    return await response.json();
  } catch (error: any) {
    console.error("getInfuraPin error:", error?.message ?? error);
    return undefined;
  }
}

export async function isPinnedToInfura(hash: string): Promise<boolean> {
  try {
    const result = await getInfuraPin(hash);
    return (
      (result && result.Keys && result?.Keys[hash]?.Type === "recursive") ??
      false
    );
  } catch (error: any) {
    console.error("isPinnedToInfura error:", error?.message ?? error);
    return false;
  }
}
