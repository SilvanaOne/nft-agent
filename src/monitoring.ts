import {
  NftTransactionType,
  config,
  getNftInfo,
  NftRequestAnswer,
} from "@silvana-one/api";
import { pinIfNeeded } from "./pin.js";

export interface NFTtransaction {
  hash: string;
  chain: string;
  collectionAddress: string;
  nftAddress?: string;
  jobId: string;
  sender: string;
  operation: NftTransactionType;
  price?: string;
  name: string;
}

export async function updateNftInfo(
  tx: NFTtransaction
): Promise<NftRequestAnswer | undefined> {
  const { collectionAddress, nftAddress, chain } = tx;
  try {
    config({
      apiKey: process.env.MINATOKENS_API_KEY!,
      chain: tx.chain as "mainnet" | "devnet" | "zeko",
    });
    const info = (
      await getNftInfo({
        body: {
          nftAddress,
          collectionAddress,
        },
      })
    ).data;
    console.log("updateNftInfo", info);
    if (info && info?.nft?.storage) {
      await pinIfNeeded({
        hash: info?.nft.storage,
        keyvalues: {
          name: info.nft?.name,
          collectionAddress: collectionAddress,
          nftAddress: nftAddress,
          chain,
          developer: "DFST",
          repo: "nft-agent",
          project: "NFT",
        },
      });
    }
    return info;
  } catch (error: any) {
    console.error("updateNftInfo", error?.message);
    return undefined;
  }
}
