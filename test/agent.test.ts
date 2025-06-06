import { describe, it } from "node:test";
import assert from "node:assert";
import {
  Mina,
  AccountUpdate,
  UInt64,
  PublicKey,
  setNumberOfWorkers,
  TokenId,
} from "o1js";
import { NftAPI } from "@silvana-one/mina-prover";
import {
  sleep,
  Memory,
  fetchMinaAccount,
  fee,
  initBlockchain,
  accountBalanceMina,
  createTransactionPayloads,
  tokenBalance,
  getTxStatusFast,
  sendTx,
} from "@silvana-one/mina-utils";
import {
  NftTransaction,
  NftTransactionParams,
  LaunchNftCollectionStandardAdminParams,
  LaunchNftCollectionAdvancedAdminParams,
  NftTransactionType,
  JobResult,
  NftMintParams,
  NftData,
  NftMintTransactionParams,
  NftTransferTransactionParams,
  NftBuyTransactionParams,
  NftSellTransactionParams,
  NftApproveTransactionParams,
} from "@silvana-one/api";
import {
  buildNftCollectionLaunchTransaction,
  buildNftMintTransaction,
  buildNftTransaction,
  LAUNCH_FEE,
  TRANSACTION_FEE,
} from "@silvana-one/abi";
import { zkcloudworker } from "../index.js";
import { TEST_ACCOUNTS } from "./helpers/config.js";
import {
  randomBanner,
  randomImage,
  randomName,
  randomText,
} from "./helpers/metadata.js";
import { processArguments } from "./helpers/utils.js";

const JWT: string = process.env.JWT!;
if (!process.env.WALLET) throw new Error("WALLET is not set");
const wallet = PublicKey.fromBase58(process.env.WALLET);
const { TestPublicKey } = Mina;
type TestPublicKey = Mina.TestPublicKey;

setNumberOfWorkers(8);

const args = processArguments();
console.log("args:", args);
const {
  chain,
  useLocalCloudWorker,
  deploy,
  mint,
  transfer,
  sell,
  buy,
  useAdvancedAdmin,
} = args;

const DELAY = chain === "local" ? 1000 : chain === "zeko" ? 3000 : 10000;

const api = new NftAPI({
  jwt: useLocalCloudWorker ? "local" : JWT,
  zkcloudworker,
  chain,
});

let accounts: {
  name: string;
  publicKey: PublicKey;
  balance?: number;
  tokenBalance?: number;
}[] = [];

let collectionKey = TestPublicKey.random();
let adminKey = TestPublicKey.random();
const tokenId = TokenId.derive(collectionKey);

describe("NFT Agent", async () => {
  const symbol = "NFT";
  const name = "StandardCollection";
  const nftAddresses: PublicKey[] = [];
  const offerAddresses: PublicKey[] = [];
  const nftOwners: PublicKey[] = [];
  const nftNames: string[] = [];
  let keys: TestPublicKey[];
  let admin: TestPublicKey;
  let user1: TestPublicKey;
  let user2: TestPublicKey;
  let user3: TestPublicKey;
  let user4: TestPublicKey;
  let buyer: TestPublicKey;
  let bidder: TestPublicKey;
  // const offer = TestPublicKey.random();
  // const bid = TestPublicKey.random();

  it(`should initialize blockchain`, async () => {
    Memory.info("initializing blockchain");

    if (chain === "local" || chain === "lightnet") {
      console.log("local chain:", chain);
      keys = (await initBlockchain(chain, 10)).keys;
    } else {
      console.log("non-local chain:", chain);
      await initBlockchain(chain);
      keys = TEST_ACCOUNTS.map((account) =>
        TestPublicKey.fromBase58(account.privateKey)
      );
    }
    assert(keys.length >= 8, "Invalid keys");
    let topup: TestPublicKey;
    [admin, user1, user2, user3, user4, topup, bidder, buyer] = keys;
    accounts = [
      { name: "admin", publicKey: admin },
      { name: "user1", publicKey: user1 },
      { name: "user2", publicKey: user2 },
      { name: "user3", publicKey: user3 },
      { name: "user4", publicKey: user4 },
      { name: "buyer", publicKey: buyer },
      { name: "bidder", publicKey: bidder },
      // { name: "offer", publicKey: offer },
      // { name: "bid", publicKey: bid },
      { name: "wallet", publicKey: wallet },
      { name: "adminContract", publicKey: adminKey },
      { name: "collectionContract", publicKey: collectionKey },
    ];
    await fetchMinaAccount({ publicKey: wallet, force: false });
    if (!Mina.hasAccount(wallet)) {
      const topupTx = await Mina.transaction(
        {
          sender: topup,
          fee: await fee(),
          memo: "topup",
        },
        async () => {
          const senderUpdate = AccountUpdate.createSigned(topup);
          senderUpdate.balance.subInPlace(1000000000);
          senderUpdate.send({ to: wallet, amount: 1_000_000_000 });
        }
      );
      topupTx.sign([topup.key]);
      await sendTx({ tx: topupTx, description: "topup" });
    }
    await fetchMinaAccount({ publicKey: user1, force: false });
    if (!Mina.hasAccount(user1)) {
      const topupTx = await Mina.transaction(
        {
          sender: topup,
          fee: await fee(),
          memo: "topup user1",
        },
        async () => {
          const senderUpdate = AccountUpdate.createSigned(topup);
          senderUpdate.balance.subInPlace(1000000000);
          senderUpdate.send({ to: user1, amount: 10_000_000_000 });
        }
      );
      topupTx.sign([topup.key]);
      await sendTx({ tx: topupTx, description: "topup user1" });
    }
    await fetchMinaAccount({ publicKey: user2, force: false });
    if (!Mina.hasAccount(user2)) {
      const topupTx = await Mina.transaction(
        {
          sender: topup,
          fee: await fee(),
          memo: "topup user2",
        },
        async () => {
          const senderUpdate = AccountUpdate.createSigned(topup);
          senderUpdate.balance.subInPlace(1000000000);
          senderUpdate.send({ to: user2, amount: 10_000_000_000 });
        }
      );
      topupTx.sign([topup.key]);
      await sendTx({ tx: topupTx, description: "topup user2" });
    }

    console.log("collection:", collectionKey.toBase58());
    console.log("admin:", adminKey.toBase58());
    console.log("creator:", admin.toBase58());
    await printBalances();
  });

  if (deploy) {
    it(`should deploy contract`, async () => {
      console.log("deploying contract");
      console.time("deployed");
      const whitelist = [
        { address: user1, amount: UInt64.from(1000e9) },
        { address: user2, amount: UInt64.from(1000e9) },
      ];

      const adminType = useAdvancedAdmin ? "advanced" : "standard";
      const nftData: NftData = {
        owner: admin.toBase58(),
      };
      const collectionName = randomName();
      const mintParams: NftMintParams = {
        name: collectionName,
        address: collectionKey.toBase58(),
        data: nftData,
        metadata: {
          name: collectionName,
          image: randomImage(),
          banner: randomBanner(),
          description: randomText(),
        },
      };
      await fetchMinaAccount({ publicKey: admin, force: true });
      const args:
        | LaunchNftCollectionAdvancedAdminParams
        | LaunchNftCollectionStandardAdminParams = {
        txType: "nft:launch",
        collectionName,
        adminContract: "standard",
        sender: admin.toBase58(),
        nonce: Number(Mina.getAccount(admin).nonce.toBigint()),
        memo: `NFT collection ${collectionName}`.substring(0, 30),
        symbol: "NFT",
        collectionAddress: collectionKey.toBase58(),
        adminContractAddress: adminKey.toBase58(),
        masterNFT: mintParams,
      };
      console.log("args nonce:", args.nonce);
      const { tx, request, storage, metadataRoot } =
        await buildNftCollectionLaunchTransaction({
          chain,
          args,
          provingKey: process.env.WALLET!,
          provingFee: LAUNCH_FEE,
        });
      // if (args.adminContract === "advanced" && "whitelist" in request)
      //   args.whitelist = request.whitelist;

      tx.sign([admin.key, adminKey.key, collectionKey.key]);
      const payloads = createTransactionPayloads(tx);
      console.log("sending deploy transaction");
      if (request.adminContract !== adminType)
        throw new Error("Admin type mismatch");
      const txPayload: NftTransaction = {
        collectionName,
        nftName: collectionName,
        request: {
          ...(request as any),
          txType: "nft:launch",
          masterNFT: {
            ...(request as any).masterNFT,
            metadata: metadataRoot,
            storage,
          },
        },
        ...payloads,
        symbol,
        sender: admin.toBase58(),
      };
      const jobId = await api.proveTransaction(txPayload);

      console.log("deploy jobId:", jobId);
      assert(jobId !== undefined, "Deploy jobId is undefined");
      await api.waitForJobResults({ jobId, printLogs: true });
      const proofs = await api.getResults(jobId);
      console.log("proofs", proofs);
      if (
        !("results" in proofs) ||
        !proofs.results ||
        proofs.results.length === 0
      )
        throw new Error("Results not found");
      const hash = proofs.results[0].hash;
      assert(hash !== undefined, "Deploy hash is undefined");
      console.log("deploy hash:", hash);
      console.time("deploy tx included");
      console.log("waiting for deploy tx to be included...");
      const txStatus = await getTxStatusFast({ hash });
      console.log("txStatus deploy", txStatus);
      while (!(await getTxStatusFast({ hash })).result === true) {
        await sleep(10000);
      }
      console.timeEnd("deploy tx included");
      Memory.info("deployed");
      console.timeEnd("deployed");
      const txStatus2 = await getTxStatusFast({ hash });
      console.log("txStatus deploy post", txStatus2);
      if (chain !== "local") await sleep(DELAY);
      await printBalances();
    });
  }

  if (mint) {
    it(`should mint NFT`, async () => {
      console.time("minted");
      await fetchMinaAccount({ publicKey: admin, force: true });
      let nonce = Number(Mina.getAccount(admin).nonce.toBigint());
      const ownerArray: TestPublicKey[] = [user1, user2];
      const hashArray: string[] = [];

      for (const owner of ownerArray) {
        const nftKey = TestPublicKey.random();
        nftAddresses.push(nftKey);
        nftOwners.push(owner);

        console.log("nft:", nftKey.toBase58());
        console.log("owner:", owner.toBase58());
        const nftData: NftData = {
          owner: owner.toBase58(),
        };
        const nftName = randomName();
        nftNames.push(nftName);
        const mintParams: NftMintParams = {
          name: nftName,
          address: nftKey.toBase58(),
          data: nftData,
          metadata: {
            name: nftName,
            image: randomImage(),
            description: randomText(),
          },
        };
        const { tx, request, storage, metadataRoot } =
          await buildNftMintTransaction({
            chain,
            args: {
              txType: "nft:mint",
              sender: admin.toBase58(),
              nonce: nonce++,
              memo: `mint NFT ${nftName}`,
              collectionAddress: collectionKey.toBase58(),
              nftMintParams: mintParams,
            },
            provingKey: process.env.WALLET!,
            provingFee: LAUNCH_FEE,
          });

        tx.sign([admin.key, nftKey.key]);

        const payloads = createTransactionPayloads(tx);

        const jobId = await api.proveTransaction({
          request: {
            ...(request as NftMintTransactionParams),
            txType: "nft:mint",
            nftMintParams: {
              ...mintParams,
              storage,
              metadata: metadataRoot,
            },
          },
          ...payloads,
          symbol,
        } as NftTransaction);
        console.log("mint jobId:", jobId);
        assert(jobId !== undefined, "Mint jobId is undefined");
        await api.waitForJobResults({ jobId, printLogs: true });
        const proofs = await api.getResults(jobId);
        if (
          !("results" in proofs) ||
          !proofs.results ||
          proofs.results.length === 0
        )
          throw new Error("Results not found");
        const hash = proofs.results[0].hash;
        assert(hash !== undefined, "Mint hash is undefined");
        console.log("mint hash:", hash);
        hashArray.push(hash);
      }

      for (const hash of hashArray) {
        console.log("Waiting for mint tx to be included...", hash);
        while (!(await getTxStatusFast({ hash })).result === true) {
          await sleep(10000);
        }
        console.log("mint tx included", hash);
      }
      Memory.info("minted");
      console.timeEnd("minted");
      if (chain !== "local") await sleep(DELAY);
      await printBalances();
      await fetchMinaAccount({
        publicKey: adminKey,
        tokenId: TokenId.derive(adminKey),
        force: false,
      });
      const tb = await tokenBalance(adminKey, TokenId.derive(adminKey));
      console.log("admin token balance", (tb ?? 0) / 1_000_000_000);
    });
  }

  if (transfer) {
    it(`should transfer NFT`, async () => {
      console.time("transferred");
      await fetchMinaAccount({ publicKey: admin, force: true });

      const ownerArray: TestPublicKey[] = [user1, user2];
      const toArray: TestPublicKey[] = [user3, user4];
      const hashArray: string[] = [];

      for (let i = 0; i < nftAddresses.length; i++) {
        const nftAddress = nftAddresses[i];
        const nftName = nftNames[i];
        const owner = nftOwners[i];
        const to = toArray[i];
        const ownerKey = ownerArray[i];
        assert(ownerKey.toBase58() === owner.toBase58(), "Owner mismatch");
        console.log("nft:", nftAddress.toBase58());
        console.log("owner:", owner.toBase58());
        console.log("to:", to.toBase58());
        const nonce = Number(Mina.getAccount(owner).nonce.toBigint());
        const { tx, request, storage, metadataRoot } =
          await buildNftTransaction({
            chain,
            args: {
              txType: "nft:transfer",
              nftAddress: nftAddress.toBase58(),
              sender: owner.toBase58(),
              nonce,
              memo: `transfer NFT ${nftName}`,
              collectionAddress: collectionKey.toBase58(),
              nftTransferParams: {
                to: to.toBase58(),
                from: owner.toBase58(),
              },
            },
            provingKey: process.env.WALLET!,
            provingFee: TRANSACTION_FEE,
          });

        tx.sign([ownerKey.key]);

        const payloads = createTransactionPayloads(tx);

        const jobId = await api.proveTransaction({
          request: {
            ...(request as NftTransferTransactionParams),
            txType: "nft:transfer",
            nftTransferParams: {
              from: owner.toBase58(),
              to: to.toBase58(),
            },
          },
          ...payloads,
          symbol,
        } as NftTransaction);
        console.log("transfer jobId:", jobId);
        assert(jobId !== undefined, "Transfer jobId is undefined");
        await api.waitForJobResults({ jobId, printLogs: true });
        const proofs = await api.getResults(jobId);
        if (
          !("results" in proofs) ||
          !proofs.results ||
          proofs.results.length === 0
        )
          throw new Error("Results not found");
        const hash = proofs.results[0].hash;
        assert(hash !== undefined, "Transfer hash is undefined");
        console.log("transfer hash:", hash);
        hashArray.push(hash);
      }

      for (const hash of hashArray) {
        console.log("Waiting for transfer tx to be included...", hash);
        while (!(await getTxStatusFast({ hash })).result === true) {
          await sleep(10000);
        }
        console.log("transfer tx included", hash);
      }
      Memory.info("transferred");
      console.timeEnd("transferred");
      if (chain !== "local") await sleep(DELAY);
      await printBalances();
    });
  }

  if (sell) {
    it(`should sell NFT`, async () => {
      console.time("sold");
      await fetchMinaAccount({ publicKey: admin, force: true });

      const ownerArray: TestPublicKey[] = [user3, user4];
      const hashArray: string[] = [];

      for (let i = 0; i < nftAddresses.length; i++) {
        const nftAddress = nftAddresses[i];
        const nftName = nftNames[i];
        const owner = ownerArray[i];
        const offerAddress = TestPublicKey.random();
        offerAddresses.push(offerAddress);
        console.log("nft:", nftAddress.toBase58());
        console.log("offer:", offerAddress.toBase58());
        const nonce = Number(Mina.getAccount(owner).nonce.toBigint());
        const { tx, request, storage, metadataRoot } =
          await buildNftTransaction({
            chain,
            args: {
              txType: "nft:sell",
              nftAddress: nftAddress.toBase58(),
              sender: owner.toBase58(),
              nonce,
              memo: `sell NFT ${nftName}`,
              collectionAddress: collectionKey.toBase58(),
              nftSellParams: {
                price: 25,
                offerAddress: offerAddress.toBase58(),
              },
            },
            provingKey: process.env.WALLET!,
            provingFee: TRANSACTION_FEE,
          });

        tx.sign([owner.key, offerAddress.key]);

        const payloads = createTransactionPayloads(tx);

        const jobId = await api.proveTransaction({
          request: {
            ...(request as NftSellTransactionParams),
            txType: "nft:sell",
            nftSellParams: {
              price: 25,
              offerAddress: offerAddress.toBase58(),
            },
          },
          ...payloads,
          symbol,
        } as NftTransaction);
        console.log("sell jobId:", jobId);
        assert(jobId !== undefined, "Sell jobId is undefined");
        await api.waitForJobResults({ jobId, printLogs: true });
        const proofs = await api.getResults(jobId);
        if (
          !("results" in proofs) ||
          !proofs.results ||
          proofs.results.length === 0
        )
          throw new Error("Results not found");
        const hash = proofs.results[0].hash;
        assert(hash !== undefined, "Sell hash is undefined");
        console.log("sell hash:", hash);
        hashArray.push(hash);
      }

      for (const hash of hashArray) {
        console.log("Waiting for sell tx to be included...", hash);
        while (!(await getTxStatusFast({ hash })).result === true) {
          await sleep(10000);
        }
        console.log("sell tx included", hash);
      }
      Memory.info("sold");
      console.timeEnd("sold");
      if (chain !== "local") await sleep(DELAY);
      await printBalances();
    });
  }
  if (buy) {
    it(`should buy NFT`, async () => {
      console.time("bought");
      await fetchMinaAccount({ publicKey: admin, force: true });

      const buyerArray: TestPublicKey[] = [user1, user2];
      const hashArray: string[] = [];

      for (let i = 0; i < nftAddresses.length; i++) {
        const nftAddress = nftAddresses[i];
        const nftName = nftNames[i];
        const buyer = buyerArray[i];
        const offerAddress = offerAddresses[i];
        console.log("nft:", nftAddress.toBase58());
        console.log("buyer:", buyer.toBase58());
        console.log("offer:", offerAddress.toBase58());
        const nonce = Number(Mina.getAccount(buyer).nonce.toBigint());
        const { tx, request, storage, metadataRoot } =
          await buildNftTransaction({
            chain,
            args: {
              txType: "nft:buy",
              nftAddress: nftAddress.toBase58(),
              sender: buyer.toBase58(),
              nonce,
              memo: `buy NFT ${nftName}`,
              collectionAddress: collectionKey.toBase58(),
              nftBuyParams: {
                buyer: buyer.toBase58(),
              },
            },
            provingKey: process.env.WALLET!,
            provingFee: TRANSACTION_FEE,
          });

        tx.sign([buyer.key]);

        const payloads = createTransactionPayloads(tx);

        const jobId = await api.proveTransaction({
          request: {
            ...(request as NftBuyTransactionParams),
            txType: "nft:buy",
            nftBuyParams: {
              buyer: buyer.toBase58(),
            },
          },
          ...payloads,
          symbol,
        } as NftTransaction);
        console.log("buy jobId:", jobId);
        assert(jobId !== undefined, "Buy jobId is undefined");
        await api.waitForJobResults({ jobId, printLogs: true });
        const proofs = await api.getResults(jobId);
        if (
          !("results" in proofs) ||
          !proofs.results ||
          proofs.results.length === 0
        )
          throw new Error("Results not found");
        const hash = proofs.results[0].hash;
        assert(hash !== undefined, "Buy hash is undefined");
        console.log("buy hash:", hash);
        hashArray.push(hash);
      }

      for (const hash of hashArray) {
        console.log("Waiting for buy tx to be included...", hash);
        while (!(await getTxStatusFast({ hash })).result === true) {
          await sleep(10000);
        }
        console.log("buy tx included", hash);
      }
      Memory.info("bought");
      console.timeEnd("bought");
      if (chain !== "local") await sleep(DELAY);
      await printBalances();
    });
  }
});

async function printBalances() {
  console.log("Balances:");
  for (const account of accounts) {
    await fetchMinaAccount({
      publicKey: account.publicKey,
      force: account.balance !== undefined,
    });
    await fetchMinaAccount({
      publicKey: account.publicKey,
      tokenId,
      force: account.tokenBalance !== undefined,
    });
    const balance = await accountBalanceMina(account.publicKey);
    const tb = await tokenBalance(account.publicKey, tokenId);
    if (account.balance !== balance || account.tokenBalance !== tb) {
      const balanceDiff =
        account.balance !== undefined ? balance - account.balance : balance;
      const tokenBalanceDiff =
        tb !== undefined
          ? account.tokenBalance
            ? tb - account.tokenBalance
            : tb
          : 0;
      console.log(
        `${account.name} (${account.publicKey.toBase58()}): ${balance} MINA ${
          account.balance
            ? "(" + (balanceDiff >= 0 ? "+" : "") + balanceDiff.toString() + ")"
            : ""
        }, ${tb ? tb / 1_000_000_000 : 0} NFT ${
          account.tokenBalance
            ? "(" +
              (tokenBalanceDiff >= 0 ? "+" : "") +
              (tokenBalanceDiff / 1_000_000_000).toString() +
              ")"
            : ""
        }`
      );
      account.balance = balance;
      account.tokenBalance = tb;
    }
  }
}
