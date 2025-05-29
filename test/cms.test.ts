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
import { TEST_ACCOUNTS } from "./helpers/config.js";
import {
  randomBanner,
  randomImage,
  randomName,
  randomText,
} from "./helpers/metadata.js";
import { processArguments } from "./helpers/utils.js";
import {
  ApolloClient,
  ApolloLink,
  gql,
  HttpLink,
  InMemoryCache,
} from "@apollo/client/core";
import fs from "node:fs";
import path from "node:path";
import {
  NftMintParams,
  NftData,
  CollectionData,
  CollectionInfo,
  NftInfo,
} from "@silvana-one/api";

const JWT: string = process.env.JWT!;

//Authorization: Bearer key
const CMS_API_KEY = process.env.CMS_API_KEY!;
const CMS_ENDPOINT = process.env.CMS_ENDPOINT!;

const backend = new HttpLink({
  uri: CMS_ENDPOINT,
  headers: {
    Authorization: `Bearer ${CMS_API_KEY}`,
  },
});

const client = new ApolloClient({
  link: ApolloLink.split(
    (operation) => operation.getContext().clientName === "backend",
    backend,
    backend
  ),
  cache: new InMemoryCache(),
});

const { TestPublicKey } = Mina;
type TestPublicKey = Mina.TestPublicKey;
const collectionKey = TestPublicKey.random();
const nftKey = TestPublicKey.random();
const tokenId = TokenId.derive(collectionKey);
const keys = TEST_ACCOUNTS.map((account) =>
  TestPublicKey.fromBase58(account.privateKey)
);

assert(keys.length >= 8, "Invalid keys");
const [admin, user1, user2, user3, user4, topup, bidder, buyer] = keys;

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

describe("CMS", async () => {
  it.skip("should read schema", async () => {
    try {
      // Define the GraphQL query to fetch the schema
      const GET_SCHEMA = gql`
        {
          __schema {
            types {
              name
              kind
              description
              fields {
                name
                description
                type {
                  name
                  kind
                  ofType {
                    name
                    kind
                  }
                }
              }
            }
          }
        }
      `;

      // Execute the query with the Apollo client
      const result = await client.query({
        query: GET_SCHEMA,
        context: {
          clientName: "backend",
        },
      });

      //console.log("CMS Schema:", result.data);

      const helpersDir = "./test/helpers";
      const schemaPath = path.join(helpersDir, "schema.json");
      await fs.promises.writeFile(
        schemaPath,
        JSON.stringify(result.data, null, 2),
        "utf8"
      );

      console.log(`Schema saved to ${schemaPath}`);
      assert(result.data, "No data received from CMS");
    } catch (error) {
      console.error("Error fetching data from CMS:", error);
      throw error;
    }
  });
  it("create a write a collection", async () => {
    const collectionName = randomName();
    const adminType = "standard";
    const nftData: NftData = {
      owner: admin.toBase58(),
    };
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
    console.log("mintParams:", mintParams);
  });
});
