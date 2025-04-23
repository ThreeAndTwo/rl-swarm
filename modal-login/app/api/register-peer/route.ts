import { TurnkeyClient } from "@turnkey/http";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { getLatestApiKey, getUser } from "@/app/db";
import { NextResponse } from "next/server";
import {
  Address,
  createWalletClient,
  Hex,
  SignableMessage,
  hashMessage,
  encodeFunctionData,
} from "viem";
import {
  alchemy,
  createAlchemySmartAccountClient,
  gensynTestnet,
} from "@account-kit/infra";
import { toAccount } from "viem/accounts";
import { WalletClientSigner } from "@aa-sdk/core";
import { createModularAccountV2 } from "@account-kit/smart-contracts";

const TURNKEY_BASE_URL = "https://api.turnkey.com";
const ALCHEMY_BASE_URL = "https://api.g.alchemy.com";

export async function POST(request: Request) {
  const body: { orgId: string; peerId: string } = await request
    .json()
    .catch((err) => {
      console.error(err);
      return NextResponse.json(
        { error: "bad request" },
        {
          status: 400,
        },
      );
    });
  if (!body.orgId) {
    return NextResponse.json(
      { error: "bad request" },
      {
        status: 400,
      },
    );
  }
  console.log(body.orgId);

  try {
    console.log(`[RegisterPeer] Processing request for orgId: ${body.orgId}, peerId: ${body.peerId}`);
    
    const user = getUser(body.orgId);
    if (!user) {
      console.log(`[RegisterPeer] User not found for orgId: ${body.orgId}`);
      return NextResponse.json(
        { error: "user not found" },
        {
          status: 404,
        },
      );
    }
    console.log(`[RegisterPeer] Found user with address: ${user.address}`);

    const apiKey = getLatestApiKey(body.orgId);
    if (!apiKey) {
      console.log(`[RegisterPeer] API key not found for orgId: ${body.orgId}`);
      return NextResponse.json(
        { error: "api key not found" },
        {
          status: 500,
        },
      );
    }
    console.log(`[RegisterPeer] Retrieved API key for user`);

    const transport = alchemy({
      apiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY!,
    });
    console.log(`[RegisterPeer] Initialized Alchemy transport`);

    console.log(`[RegisterPeer] Creating modular account for user address: ${user.address}`);
    const account = await createModularAccountV2({
      transport,
      chain: gensynTestnet,
      signer: createSignerForUser(user, apiKey),
    });
    console.log(`[RegisterPeer] Created modular account with address: ${account.address}`);

    console.log(`[RegisterPeer] Initializing Alchemy Smart Account client`);
    const client = createAlchemySmartAccountClient({
      account,
      chain: gensynTestnet,
      transport,
      policyId: process.env.NEXT_PUBLIC_PAYMASTER_POLICY_ID!,
    });
    console.log(`[RegisterPeer] Initialized Smart Account client with policy ID: ${process.env.NEXT_PUBLIC_PAYMASTER_POLICY_ID}`);


    // Check if the user's address already registered for better error handling.
    /*
    const existingPeerId = await client.readContract({
      abi: [
        {
          inputs: [
            {
              internalType: "address",
              name: "eoa",
              type: "address",
            },
          ],
          name: "getPeerId",
          outputs: [
            {
              internalType: "string",
              name: "",
              type: "string",
            },
          ],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "getPeerId",
      args: [account.address as Address],
      address: "0x6484a07281B72b8b541A86Ec055534223672c2fb",
    });
    if (existingPeerId) {
      console.log(
        `Address ${account.address} already registered with peerId ${existingPeerId}`,
      );
      return NextResponse.json(
        { error: "account address already registered" },
        {
          status: 400,
        },
      );
    }
    */

    const contractAdrr = process.env.SMART_CONTRACT_ADDRESS! as `0x${string}`;
    console.log(`[RegisterPeer] Using smart contract address: ${contractAdrr}`);

    console.log(`[RegisterPeer] Preparing to send registerPeer operation with peerId: ${body.peerId}`);
    const functionData = encodeFunctionData({
      abi: [
        {
          name: "registerPeer",
          type: "function",
          inputs: [
            {
              name: "peerId",
              type: "string",
              internalType: "string",
            },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ],
      functionName: "registerPeer",
      args: [body.peerId],
    });
    console.log(`[RegisterPeer] Encoded function data: ${functionData}`);

    console.log(`[RegisterPeer] Sending user operation...`);
    const { hash } = await client.sendUserOperation({
      uo: {
        target: contractAdrr,
        data: functionData,
      },
    });
    console.log(`[RegisterPeer] User operation sent successfully with hash: ${hash}`);
    return NextResponse.json(
      {
        hash,
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "error" },
      {
        status: 500,
      },
    );
  }
}

function createSignerForUser(
  user: { orgId: string; address: string },
  apiKey: { publicKey: string; privateKey: string },
) {
  console.log(`[RegisterPeer] Creating signer for user with orgId: ${user.orgId}, address: ${user.address}`);
  
  const stamper = new ApiKeyStamper({
    apiPublicKey: apiKey.publicKey,
    apiPrivateKey: apiKey.privateKey,
  });
  console.log(`[RegisterPeer] Initialized ApiKeyStamper`);
  
  const tk = new TurnkeyClient({ baseUrl: TURNKEY_BASE_URL }, stamper);
  console.log(`[RegisterPeer] Created TurnkeyClient with base URL: ${TURNKEY_BASE_URL}`);

  const signMessage = async (message: SignableMessage) => {
    console.log(`[RegisterPeer] Starting message signing process`);
    const payload = hashMessage(message);
    console.log(`[RegisterPeer] Generated message hash payload`);

    // Sign with the api key stamper first.
    console.log(`[RegisterPeer] Preparing Turnkey sign request for address: ${user.address}`);
    const stampedRequest = await tk.stampSignRawPayload({
      organizationId: user.orgId,
      timestampMs: Date.now().toString(),
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      parameters: {
        signWith: user.address,
        payload,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP",
      },
    });
    console.log(`[RegisterPeer] Successfully stamped sign request with Turnkey`);

    // Then submit to Alchemy.
    console.log(`[RegisterPeer] Submitting stamped request to Alchemy for signing`);
    const alchemyResp = await fetch(
      `${ALCHEMY_BASE_URL}/signer/v1/sign-payload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          stampedRequest,
        }),
      },
    );
    if (!alchemyResp.ok) {
      const errorText = await alchemyResp.text();
      console.error(`[RegisterPeer] Alchemy sign request failed: ${errorText}`);
      throw new Error("Alchemy sign request failed");
    }

    const respJson = (await alchemyResp.json()) as { signature: Hex };
    console.log(`[RegisterPeer] Successfully obtained signature from Alchemy`);
    return respJson.signature;
  };

  console.log(`[RegisterPeer] Creating signer account with address: ${user.address}`);
  const signerAccount = toAccount({
    address: user.address as Address,
    signMessage: async ({ message }) => {
      return signMessage(message);
    },
    signTransaction: async () => {
      throw new Error("Not implemented");
    },
    signTypedData: async () => {
      throw new Error("Not implemented");
    },
  });

  console.log(`[RegisterPeer] Creating wallet client with Alchemy transport`);
  const walletClient = createWalletClient({
    account: signerAccount,
    chain: gensynTestnet,
    transport: alchemy({
      apiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY!,
    }),
  });

  console.log(`[RegisterPeer] Returning WalletClientSigner instance`);
  return new WalletClientSigner(walletClient, "custom");
}
