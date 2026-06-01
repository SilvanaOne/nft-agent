import { pinToPinata, fetchPin } from "./pinata.js";

export async function pinIfNeeded(params: {
  hash: string;
  keyvalues: {
    name: string;
    collectionAddress: string;
    nftAddress?: string;
    address?: string;
    chain: string;
    developer: string;
    repo: string;
    project: string;
  };
}): Promise<boolean> {
  const { hash, keyvalues } = params;
  try {
    let pinned = false;
    const pinataPin = await fetchPin(hash);
    if (pinataPin) {
      //console.log("Already pinned to Pinata", hash);
    } else {
      console.log("Pinning to Pinata", hash);
      const result = await pinToPinata(params);
      console.log("Pinata pin result:", { hash, result });
      pinned = true;
    }

    return pinned;
  } catch (error) {
    console.error("pinIfNeeded error", { hash, error });
    return false;
  }
}
