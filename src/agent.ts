import {
  zkCloudWorker,
  Cloud,
  sleep,
  TransactionMetadata,
  CloudTransaction,
} from "@silvana-one/prover";

import {
  transactionParams,
  parseTransactionPayloads,
  initBlockchain,
} from "@silvana-one/mina-utils";
import {
  NftTransaction,
  NftTransactionParams,
  LaunchNftCollectionStandardAdminParams,
  LaunchNftCollectionAdvancedAdminParams,
  NftTransactionType,
  JobResult,
  NftTransferTransactionParams,
  NftBuyTransactionParams,
  NftSellTransactionParams,
  NftMintTransactionParams,
  NftApproveTransactionParams,
  CanonicalBlockchain,
} from "@silvana-one/api";
import { Collection, AdvancedCollection } from "@silvana-one/nft";
import {
  contractList,
  tokenVerificationKeys,
  buildNftCollectionLaunchTransaction,
  buildNftTransaction,
  LAUNCH_FEE,
  TRANSACTION_FEE,
  NftAdminType,
  buildNftMintTransaction,
} from "@silvana-one/abi";
import { VerificationKey, Cache, Transaction, Mina } from "o1js";
import { saveToIPFS } from "./ipfs.js";
import { pinIfNeeded } from "./pin.js";
import { nanoid } from "nanoid";
import { txStatus } from "./txstatus.js";
import { updateNftInfo, NFTtransaction } from "./monitoring.js";
const WALLET = process.env.WALLET;

export class NFTAgent extends zkCloudWorker {
  static verificationKeys: {
    [key: string]: VerificationKey;
  } = {};

  readonly cache: Cache;

  constructor(cloud: Cloud) {
    super(cloud);
    this.cache = Cache.FileSystem(this.cloud.cache);
  }

  private async compile(params: {
    compileAdmin?: boolean;
    adminType?: NftAdminType;
    verificationKeyHashes: string[];
  }): Promise<void> {
    console.log("Compile", params);
    const {
      compileAdmin = false,
      adminType = "standard",
      verificationKeyHashes,
    } = params;
    try {
      console.time("compiled");
      const vk =
        tokenVerificationKeys[
          this.cloud.chain === "mina:mainnet" ? "mainnet" : "devnet"
        ].vk;
      for (const hash of verificationKeyHashes) {
        const [key, item] =
          Object.entries(vk).find(([_, item]) => item.hash === hash) || [];
        if (!key) throw new Error(`Key not found for hash ${hash}`);
        if (!item) throw new Error(`Verification key for ${hash} not found`);
        console.log("Compiling", item.type, key);
        switch (item.type) {
          case "collection":
            if (adminType === "advanced" && compileAdmin) {
              if (!NFTAgent.verificationKeys.AdvancedCollection) {
                console.time("compiled AdvancedCollection");
                NFTAgent.verificationKeys.AdvancedCollection = (
                  await AdvancedCollection.compile({
                    cache: this.cache,
                  })
                ).verificationKey;
                console.timeEnd("compiled AdvancedCollection");
              }
              if (
                NFTAgent.verificationKeys.AdvancedCollection?.hash.toJSON() !==
                hash
              )
                throw new Error(
                  `Expected verification key for ${key} ${adminType} (${hash}) does not match actual AdvancedCollection hash ${NFTAgent.verificationKeys.AdvancedCollection?.hash.toJSON()}`
                );
            } else {
              if (!NFTAgent.verificationKeys.Collection) {
                console.time("compiled Collection");
                NFTAgent.verificationKeys.Collection = (
                  await Collection.compile({
                    cache: this.cache,
                  })
                ).verificationKey;
                console.timeEnd("compiled Collection");
              }
              if (NFTAgent.verificationKeys.Collection?.hash.toJSON() !== hash)
                throw new Error(
                  `Expected verification key for ${key} ${adminType} (${hash}) does not match actual Collection hash ${NFTAgent.verificationKeys.Collection?.hash.toJSON()}`
                );
            }
            break;

          case "admin":
          case "user":
          case "nft":
            if (item.type === "admin" && !compileAdmin) break;
            const contract = contractList[key];
            if (!contract) throw new Error(`Contract ${key} not found`);
            if (!NFTAgent.verificationKeys[key]) {
              console.time(`compiled ${key}`);
              NFTAgent.verificationKeys[key] = (
                await contract.compile({
                  cache: this.cache,
                })
              ).verificationKey;
              console.timeEnd(`compiled ${key}`);
            }
            if (NFTAgent.verificationKeys[key].hash.toJSON() !== hash)
              throw new Error(
                `Expected verification key for ${key} (${hash}) does not match actual hash ${NFTAgent.verificationKeys[
                  key
                ].hash.toJSON()}`
              );
            break;

          case "upgrade":
            throw new Error(`Upgrade key ${key} (${hash}) not supported`);
        }
      }

      console.timeEnd("compiled");
    } catch (error) {
      console.error("Error in compile, restarting container", error);
      // Restarting the container, see https://github.com/o1-labs/o1js/issues/1651
      await this.cloud.forceWorkerRestart();
      throw error;
    }
  }

  public async create(transaction: string): Promise<string | undefined> {
    throw new Error("Method not implemented.");
  }

  public async merge(
    proof1: string,
    proof2: string
  ): Promise<string | undefined> {
    throw new Error("Method not implemented.");
  }

  public async execute(transactions: string[]): Promise<string | undefined> {
    if (transactions.length === 0) throw new Error("transactions is empty");
    if (this.cloud.task !== "prove") throw new Error("Invalid task");
    const proofs: string[] = [];
    for (const transaction of transactions) {
      const tx = JSON.parse(transaction) as NftTransaction;
      if (!tx.request) throw new Error("tx.request is undefined");
      switch (tx.request?.txType) {
        case "nft:launch":
          proofs.push(await this.launch(tx));
          break;

        case "nft:mint":
        case "nft:sell":
        case "nft:buy":
        case "nft:transfer":
        case "nft:approve":
          proofs.push(await this.transaction(tx));
          break;

        default:
          throw new Error(`Unknown txType`); //: ${tx.request?.txType}`);
      }
    }
    const result = JSON.stringify({ proofs }, null, 2);
    console.log("Proofs size", result.length);
    if (result.length > 350_000)
      console.error("Proofs size is too large:", result.length);
    return result;
  }

  private stringifyJobResult(result: JobResult): string {
    /*
        export interface JobResult {
          success: boolean;
          error?: string;
          tx?: string;
          hash?: string;
          jobStatus?: string;
        }
    */
    const strippedResult = {
      ...result,
      tx: result.hash ? undefined : result.tx,
    };
    return JSON.stringify(strippedResult, null, 2);
  }

  private async launch(args: NftTransaction): Promise<string> {
    if (
      !args.request ||
      !("adminContractAddress" in args.request) ||
      args.request.adminContractAddress === undefined ||
      args.sender === undefined ||
      args.transaction === undefined ||
      args.signedData === undefined ||
      args.request.collectionAddress === undefined ||
      args.request.symbol === undefined
    ) {
      throw new Error("One or more required args are undefined");
    }
    const sendTransaction = args.sendTransaction ?? true;
    const ipfsHash = args?.request?.masterNFT?.storage;
    let pinPromise: Promise<boolean> | undefined = undefined;
    if (ipfsHash) {
      pinPromise = pinIfNeeded({
        hash: ipfsHash,
        keyvalues: {
          name: args.request.collectionName,
          collectionAddress: args.request.collectionAddress,
          address: args.sender,
          chain: this.cloud.chain,
          developer: "DFST",
          repo: "nft-agent",
          project: "NFT",
        },
      });
    }

    if (WALLET === undefined) throw new Error("WALLET is undefined");

    console.time("prepared tx");

    const { fee, sender, nonce, memo } = transactionParams(args);
    console.log("Admin (sender)", sender.toBase58());
    if (sender.toBase58() != args.sender) throw new Error("Invalid sender");

    const {
      tx: txNew,
      adminType,
      verificationKeyHashes,
    } = await buildNftCollectionLaunchTransaction({
      chain: this.cloud.chain,
      args: args.request,
      provingKey: WALLET,
      provingFee: LAUNCH_FEE,
    });
    const tx = parseTransactionPayloads({ payloads: args, txNew });

    if (tx === undefined) throw new Error("tx is undefined");
    await this.compile({
      compileAdmin: true,
      adminType,
      verificationKeyHashes,
    });

    console.time("proved tx");
    const txProved = await tx.prove();
    const txJSON = txProved.toJSON();
    console.timeEnd("proved tx");
    console.timeEnd("prepared tx");
    console.time("pinned");
    if (pinPromise) await pinPromise;
    console.timeEnd("pinned");

    try {
      if (!sendTransaction) {
        return this.stringifyJobResult({
          success: true,
          tx: txJSON,
        });
      }

      return await this.sendTransaction({
        tx: txProved,
        txJSON,
        memo,
        metadata: {
          sender: sender.toBase58(),
          collectionAddress: args.request.collectionAddress,
          collectionSymbol: args.request.symbol,
          collectionName: args.request.collectionName,
          creator: args.request.creator,
          adminType,
          adminContractAddress: args.request.adminContractAddress,
          txType: args.request.txType,
        } as any,
        ipfsHash,
        txType: "nft:launch",
        collectionAddress: args.request.collectionAddress,
        sender: sender.toBase58(),
      });
    } catch (error) {
      console.error("Error sending transaction", error);
      return this.stringifyJobResult({
        success: false,
        tx: txJSON,
        error: String(error),
      });
    }
  }

  private async transaction(args: NftTransaction): Promise<string> {
    const { txType } = args.request;
    const {
      minaSignerPayload,
      walletPayload,
      proverPayload,
      signedData,
      transaction,
      ...logArgs
    } = args;
    console.log("transaction:", logArgs);

    if (txType === undefined || args.request.collectionAddress === undefined) {
      throw new Error("One or more required args are undefined");
    }
    const sendTransaction = args.sendTransaction ?? true;
    if (WALLET === undefined) throw new Error("WALLET is undefined");

    console.time("prepared tx");
    let pinPromise: Promise<boolean> | undefined = undefined;
    let ipfsHash: string | undefined = undefined;
    if (txType === "nft:mint") {
      ipfsHash = args?.request.nftMintParams.storage;

      if (ipfsHash) {
        pinPromise = pinIfNeeded({
          hash: ipfsHash,
          keyvalues: {
            name: args.request.nftMintParams.name,
            collectionAddress: args.request.collectionAddress,
            nftAddress: args.request.nftMintParams.address,
            address: args.sender,
            chain: this.cloud.chain,
            developer: "DFST",
            repo: "nft-agent",
            project: "NFT",
          },
        });
      }
    }

    const { fee, sender, nonce, memo } = transactionParams(args);

    if (txType === "nft:launch") {
      throw new Error("Launch transaction is not supported");
    }
    const {
      tx: txNew,
      adminType,
      adminContractAddress,
      verificationKeyHashes,
      symbol,
      collectionName,
    } = txType === "nft:mint"
      ? await buildNftMintTransaction({
          chain: this.cloud.chain,
          args: args.request as Exclude<
            NftTransactionParams,
            | LaunchNftCollectionStandardAdminParams
            | LaunchNftCollectionAdvancedAdminParams
            | NftSellTransactionParams
            | NftBuyTransactionParams
            | NftTransferTransactionParams
            | NftApproveTransactionParams
          >,
          provingKey: WALLET,
          provingFee: LAUNCH_FEE,
        })
      : await buildNftTransaction({
          chain: this.cloud.chain,
          args: args.request as Exclude<
            NftTransactionParams,
            | LaunchNftCollectionStandardAdminParams
            | LaunchNftCollectionAdvancedAdminParams
            | NftMintTransactionParams
          >,
          provingKey: WALLET,
          provingFee: TRANSACTION_FEE,
        });

    const tx = parseTransactionPayloads({ payloads: args, txNew });
    if (tx === undefined) throw new Error("tx is undefined");

    // const compileOffer = (
    //   [
    //     "offer",
    //     "buy",
    //     "withdrawOffer",
    //     "updateOfferWhitelist",
    //   ] satisfies FungibleTokenTransactionType[] as FungibleTokenTransactionType[]
    // ).includes(txType);
    // const compileBid = (
    //   [
    //     "bid",
    //     "sell",
    //     "withdrawBid",
    //     "updateBidWhitelist",
    //   ] satisfies FungibleTokenTransactionType[] as FungibleTokenTransactionType[]
    // ).includes(txType);
    const compileAdmin = true;
    await this.compile({
      compileAdmin,
      adminType,
      verificationKeyHashes,
    });

    console.time("proved tx");
    console.log(`Proving ${txType} transaction...`);
    const txProved = await tx.prove();
    console.timeEnd("proved tx");
    const txJSON = txProved.toJSON();
    console.timeEnd("prepared tx");
    console.time("pinned");
    if (pinPromise) await pinPromise;
    console.timeEnd("pinned");

    try {
      if (!sendTransaction) {
        return this.stringifyJobResult({
          success: true,
          tx: txJSON,
        });
      }
      return await this.sendTransaction({
        tx: txProved,
        txJSON,
        memo,
        metadata: {
          type: txType,
          collectionName,

          collectionAddress: args.request.collectionAddress,
          sender: sender.toBase58(),
          adminType,
          adminContractAddress: adminContractAddress.toBase58(),
          symbol,
        } as any,
        ipfsHash,
        txType,
        collectionAddress: args.request.collectionAddress,
        nftAddress: args.request.nftAddress,
        sender: sender.toBase58(),
      });
    } catch (error) {
      console.error("Error sending transaction", error);
      return this.stringifyJobResult({
        success: false,
        tx: txJSON,
        error: String(error),
      });
    }
  }

  private async sendTransaction(params: {
    tx: Transaction<true, true>;
    txJSON: string;
    memo: string;
    metadata: TransactionMetadata;
    ipfsHash?: string;
    txType: NftTransactionType;
    collectionAddress: string;
    nftAddress?: string;
    sender: string;
    price?: string;
  }): Promise<string> {
    const {
      tx,
      txJSON,
      memo,
      metadata,
      ipfsHash,
      collectionAddress,
      nftAddress,
      txType,
      sender,
      price,
    } = params;
    let txSent;
    let sent = false;
    const start = Date.now();
    const timeout = 60 * 1000;
    let ipfsPromise: Promise<string | undefined> | undefined = undefined;
    try {
      ipfsPromise = saveToIPFS({
        data: txJSON,
        filename: `${memo}.json`,
      });
    } catch (error) {
      console.error("Error saving tx to IPFS", error);
    }
    while (!sent && Date.now() - start < timeout) {
      txSent = await tx.safeSend();
      if (txSent.status === "pending") {
        sent = true;
        console.log(
          `${memo} tx sent: hash: ${txSent.hash} status: ${txSent.status}`
        );
      } else if (Date.now() - start < timeout) {
        console.log("Retrying tx", txSent.status, txSent.errors);
        await sleep(10000);
      } else {
        console.log(
          `${memo} tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status}`,
          txSent.errors
        );
      }
    }

    if (
      this.cloud.isLocalCloud &&
      txSent?.status === "pending" &&
      this.cloud.chain !== "zeko:testnet"
    ) {
      const txIncluded = await txSent.safeWait();
      console.log(
        `${memo} tx included into block: hash: ${txIncluded.hash} status: ${txIncluded.status}`
      );
    }
    const proofIpfsHash = ipfsPromise ? await ipfsPromise : undefined;
    this.cloud.publishTransactionMetadata({
      txId: txSent?.hash,
      metadata: {
        custom: {
          ...metadata,
          txStatus: txSent?.status,
          txErrors: txSent?.errors,
          txHash: txSent?.hash,
        },
        jobMetadata: {
          settlement_txs: txSent?.hash
            ? [
                {
                  chain: this.cloud.chain,
                  hash: txSent.hash,
                },
              ]
            : undefined,
          proofs: proofIpfsHash
            ? [
                {
                  storage: {
                    chain: "pinata",
                    network: this.cloud.chain,
                    hash: proofIpfsHash,
                  },
                },
              ]
            : undefined,
          data_availability_txs: ipfsHash
            ? [
                {
                  chain: "pinata",
                  network: this.cloud.chain,
                  hash: ipfsHash,
                },
              ]
            : undefined,
        },
      },
    });
    const success =
      txSent?.hash !== undefined && txSent?.status == "pending" ? true : false;
    if (success && txSent) {
      await this.saveTransaction({
        tx: txSent,
        name: memo,
        operation: txType,
        collectionAddress,
        nftAddress,
        jobId: this.cloud.jobId,
        sender,
        price,
      });
    }
    return this.stringifyJobResult({
      success,

      tx: txJSON,
      hash:
        success || this.cloud.chain !== "zeko:testnet"
          ? txSent?.hash
          : undefined,
      status: txSent?.status,
      error: String(txSent?.errors ?? ""),
    });
  }

  private async createTxTask(): Promise<string | undefined> {
    console.log(`Adding txTask`);

    const txToken = nanoid();
    await this.cloud.saveDataByKey("txToken", txToken);
    const oldTxId = await this.cloud.getDataByKey("txTask.txId");
    const txId = await this.cloud.addTask({
      args: JSON.stringify(
        {
          txToken,
        },
        null,
        2
      ),
      task: "txTask",
      maxAttempts: 72,
      metadata: `tx processing: nft-agent`,
      userId: this.cloud.userId,
    });
    if (txId !== undefined) {
      await this.cloud.saveDataByKey("txTask.txId", txId);
      if (oldTxId !== undefined) await this.cloud.deleteTask(oldTxId);
    }
    return "txTask added";
  }

  public async task(): Promise<string | undefined> {
    if (this.cloud.task === undefined) throw new Error("task is undefined");
    console.log(
      `Executing task ${this.cloud.task} with taskId ${this.cloud.taskId}`
    );
    if (!(await this.run()))
      return `task ${this.cloud.task} is already running`;
    let result: string | undefined = undefined;
    try {
      switch (this.cloud.task) {
        case "txTask":
          result = await this.txTask();
          break;

        default:
          console.error("Unknown task in task:", this.cloud.task);
      }
      await this.stop();
      return result ?? "error in task";
    } catch (error) {
      console.error("Error in task", error);
      await this.stop();
      return "error in task";
    }
  }

  private async run(): Promise<boolean> {
    const taskId = this.cloud.taskId;
    if (taskId === undefined) {
      console.error("taskId is undefined", this.cloud);
      return false;
    }
    const statusId = "task.status." + taskId;
    const status = await this.cloud.getDataByKey(statusId);
    if (status === undefined) {
      await this.cloud.saveDataByKey(statusId, Date.now().toString());
      return true;
    } else if (Date.now() - Number(status) > 1000 * 60 * 15) {
      console.error(
        "Task is running for more than 15 minutes, restarting",
        this.cloud
      );
      await this.cloud.saveDataByKey(statusId, Date.now().toString());
      return true;
    } else {
      console.log("Task is already running", taskId);
      return false;
    }
  }

  private async stop() {
    const taskId = this.cloud.taskId;
    const statusId = "task.status." + taskId;
    await this.cloud.saveDataByKey(statusId, undefined);
  }

  private async txTask(): Promise<string | undefined> {
    const txToken = await this.cloud.getDataByKey("txToken");
    if (txToken === undefined) {
      console.error("txToken is undefined, exiting");
      await this.cloud.deleteTask(this.cloud.taskId);
      return "exiting txTask due to undefined txToken";
    }
    if (this.cloud.args === undefined) {
      console.error("cloud.args are undefined, exiting");
      await this.cloud.deleteTask(this.cloud.taskId);
      return "exiting txTask due to undefined cloud.args";
    }
    if (txToken !== JSON.parse(this.cloud.args).txToken) {
      console.log("txToken is replaced, exiting");
      await this.cloud.deleteTask(this.cloud.taskId);
      return "exiting txTask due to replaced txToken";
    }
    const timeStarted = await this.cloud.getDataByKey("txTask.timeStarted");
    if (
      timeStarted !== undefined &&
      Date.now() - Number(timeStarted) < 1000 * 60
    ) {
      console.error(
        "txTask is already running, detected double invocation, exiting"
      );
      if (this.cloud.isLocalCloud === false)
        return "exiting txTask due to double invocation";
    }
    await this.cloud.saveDataByKey("txTask.timeStarted", Date.now().toString());
    const transactions = await this.cloud.getTransactions();
    console.log(`txTask with ${transactions.length} transaction(s)`);
    if (transactions.length !== 0) {
      // sort by timeReceived, ascending
      transactions.sort((a, b) => a.timeReceived - b.timeReceived);
      console.log(
        `Executing txTask with ${
          transactions.length
        } transactions, first tx created at ${new Date(
          transactions[0].timeReceived
        ).toLocaleString()}...`
      );
      try {
        // TODO: Use processTransactions ???
        const result = await this.checkTransactions(transactions);
        return result;
      } catch (error) {
        console.error("Error in txTask", error);
        return "Error in txTask";
      }
    } else {
      console.log("No transactions to process, deleting task");
      await this.cloud.deleteTask(this.cloud.taskId);
      return "no transactions to process";
    }
  }

  private async checkTransactions(transactions: CloudTransaction[]) {
    if (transactions.length === 0) return "no transactions to process";
    await initBlockchain({ chain: this.cloud.chain });
    for (const transaction of transactions) {
      try {
        const tx: NFTtransaction = JSON.parse(transaction.transaction);
        if (tx.chain === this.cloud.chain) {
          console.log(`Processing transaction`, tx);
          const status = await txStatus({
            hash: tx.hash,
            time: transaction.timeReceived,
            chain: tx.chain,
          });
          if (
            status === "applied" ||
            status === "replaced" ||
            status === "failed"
          ) {
            const info = await updateNftInfo(tx);
            await this.cloud.publishTransactionMetadata({
              txId: tx.hash,
              metadata: {
                custom: {
                  status,
                  tx,
                  info,
                },
                jobMetadata: {
                  settlement_txs: [
                    {
                      chain: tx.chain,
                      hash: tx.hash,
                    },
                  ],
                },
              },
            });
            await this.cloud.deleteTransaction(transaction.txId);
            if (status === "replaced")
              await this.cloud.saveFile(
                `${this.cloud.chain}-replaced-${tx.hash}.json`,
                Buffer.from(
                  JSON.stringify(
                    {
                      time: Date.now(),
                      timeISO: new Date(Date.now()).toISOString(),
                      hash: tx.hash,
                      status: status,
                      tx,
                      transaction,
                    },
                    null,
                    2
                  )
                )
              );
          } else if (status === "pending") {
            console.log(`Transaction ${tx.hash} is pending`);
          } else {
            console.error(
              `checkTransactions: Transaction ${tx.hash} status is ${status}`
            );
          }
        }
      } catch (error) {
        console.error("checkTransactions: Error processing transaction", error);
      }
    }
    return "txs processed";
  }

  private async saveTransaction(params: {
    tx: Mina.PendingTransaction | Mina.RejectedTransaction;
    name: string;
    operation: NftTransactionType;
    collectionAddress: string;
    nftAddress?: string;
    jobId: string;
    sender: string;
    price?: string;
  }): Promise<void> {
    const {
      tx,
      name,
      operation,
      collectionAddress,
      nftAddress,
      jobId,
      sender,
      price,
    } = params;
    const time = Date.now();
    await this.cloud.saveFile(
      `${this.cloud.chain}-${operation}-${name}-${
        tx.hash ? tx.hash : Date.now()
      }.json`,
      Buffer.from(
        JSON.stringify(
          {
            time,
            timeISO: new Date(time).toISOString(),
            hash: tx.hash,
            status: tx.status,
            errors: tx.errors,
            tx: tx.toJSON(),
          },
          null,
          2
        )
      )
    );
    if (
      tx.status === "pending" &&
      this.cloud.chain !== "mina:local" &&
      this.cloud.chain !== "zeko:testnet"
    ) {
      const nftTransaction: NFTtransaction = {
        hash: tx.hash,
        chain: this.cloud.chain as
          | "mina:devnet"
          | "mina:mainnet"
          | "zeko:testnet",
        collectionAddress,
        nftAddress,
        jobId,
        sender,
        operation,
        price,
        name,
      };
      await this.createTxTask();
      await this.cloud.sendTransactions([JSON.stringify(nftTransaction)]);
    }
  }
}
