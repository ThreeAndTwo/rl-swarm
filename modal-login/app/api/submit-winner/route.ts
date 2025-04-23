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
  const body: { orgId: string; roundNumber: bigint; winners: string[] } = await request
    .json()
    .catch((err) => {
      console.error(err);
      console.log(body)
      return NextResponse.json(
        { error: "bad request generic" },
        {
          status: 400,
        },
      );
    });
  if (!body.orgId) {
    return NextResponse.json(
      { error: "bad request orgID" },
      {
        status: 400,
      },
    );
  }

  try {
    console.log(`[SubmitWinner] Processing request for orgId: ${body.orgId}, roundNumber: ${body.roundNumber}, winners count: ${body.winners.length}`);
    
    const user = getUser(body.orgId);
    if (!user) {
      console.log(`[SubmitWinner] User not found for orgId: ${body.orgId}`);
      return NextResponse.json(
        { error: "user not found" },
        {
          status: 404,
        },
      );
    }
    console.log(`[SubmitWinner] Found user with address: ${user.address}`);

    const apiKey = getLatestApiKey(body.orgId);
    if (!apiKey) {
      console.log(`[SubmitWinner] API key not found for orgId: ${body.orgId}`);
      return NextResponse.json(
        { error: "api key not found" },
        {
          status: 500,
        },
      );
    }
    console.log(`[SubmitWinner] Retrieved API key for user`);

    const transport = alchemy({
      apiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY!,
    });
    console.log(`[SubmitWinner] Initialized Alchemy transport`);

    console.log(`[SubmitWinner] Creating modular account for user address: ${user.address}`);
    const account = await createModularAccountV2({
      transport,
      chain: gensynTestnet,
      signer: createSignerForUser(user, apiKey),
    });
    console.log(`[SubmitWinner] Created modular account with address: ${account.address}`);

    console.log(`[SubmitWinner] Initializing Alchemy Smart Account client`);
    const client = createAlchemySmartAccountClient({
      account,
      chain: gensynTestnet,
      transport,
      policyId: process.env.NEXT_PUBLIC_PAYMASTER_POLICY_ID!,
    });
    console.log(`[SubmitWinner] Initialized Smart Account client with policy ID: ${process.env.NEXT_PUBLIC_PAYMASTER_POLICY_ID}`);

    const contractAdrr = process.env.SMART_CONTRACT_ADDRESS! as `0x${string}`;
    console.log(`[SubmitWinner] Using smart contract address: ${contractAdrr}`);

    console.log(`[SubmitWinner] Preparing to submit winners for round ${body.roundNumber}`);
    const functionData = encodeFunctionData({
      abi: [
        {
          name: "submitWinners",
          type: "function",
          inputs: [
            {
              internalType: "uint256",
              name: "roundNumber",
              type: "uint256",
            },
            {
              internalType: "string[]",
              name: "winners",
              type: "string[]",
            },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ],
      functionName: "submitWinners",
      args: [body.roundNumber, body.winners],
    });
    console.log(`[SubmitWinner] Encoded function data: ${functionData}`);

    console.log(`[SubmitWinner] Sending user operation...`);
    const { hash } = await client.sendUserOperation({
      uo: {
        target: contractAdrr,
        data: functionData,
      },
    });
    console.log(`[SubmitWinner] User operation sent successfully with hash: ${hash}`);


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
  console.log(`[SubmitWinner] Creating signer for user with orgId: ${user.orgId}, address: ${user.address}`);
  
  const stamper = new ApiKeyStamper({
    apiPublicKey: apiKey.publicKey,
    apiPrivateKey: apiKey.privateKey,
  });
  console.log(`[SubmitWinner] Initialized ApiKeyStamper`);
  
  const tk = new TurnkeyClient({ baseUrl: TURNKEY_BASE_URL }, stamper);
  console.log(`[SubmitWinner] Created TurnkeyClient with base URL: ${TURNKEY_BASE_URL}`);

  const signMessage = async (message: SignableMessage) => {
    console.log(`[SubmitWinner] Starting message signing process`);
    const payload = hashMessage(message);
    console.log(`[SubmitWinner] Generated message hash payload`);

    // Sign with the api key stamper first.
    console.log(`[SubmitWinner] Preparing Turnkey sign request for address: ${user.address}`);
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
    console.log(`[SubmitWinner] Successfully stamped sign request with Turnkey`);

    // Then submit to Alchemy.
    console.log(`[SubmitWinner] Submitting stamped request to Alchemy for signing`);
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
      console.error(`[SubmitWinner] Alchemy sign request failed: ${errorText}`);
      throw new Error("Alchemy sign request failed");
    }

    const respJson = (await alchemyResp.json()) as { signature: Hex };
    console.log(`[SubmitWinner] Successfully obtained signature from Alchemy`);
    return respJson.signature;
  };

  console.log(`[SubmitWinner] Creating signer account with address: ${user.address}`);
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

  console.log(`[SubmitWinner] Creating wallet client with Alchemy transport`);
  const walletClient = createWalletClient({
    account: signerAccount,
    chain: gensynTestnet,
    transport: alchemy({
      apiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY!,
    }),
  });

  console.log(`[SubmitWinner] Returning WalletClientSigner instance`);
  return new WalletClientSigner(walletClient, "custom");
}
