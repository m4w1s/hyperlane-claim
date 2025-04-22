import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { gotScraping } from 'got-scraping';
import { Solvium } from './solvium.js';

const PROVIDERS = {
  // Ethereum
  1: new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com'),
  // Optimism
  10: new ethers.JsonRpcProvider('https://optimism-rpc.publicnode.com'),
  // Binance Smart Chain
  56: new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com'),
  // Base
  8453: new ethers.JsonRpcProvider('https://base-rpc.publicnode.com'),
  // Arbitrum
  42161: new ethers.JsonRpcProvider('https://arbitrum-one-rpc.publicnode.com'),
};
const CLAIM_CONTRACTS = {
  1: '0xe5d5e5891a11b3948d84307af7651d684b87e730',
  10: '0x93a2db22b7c736b341c32ff666307f4a9ed910f5',
  56: '0xa7d7422cf603e40854d26af151043e73c1201563',
  8453: '0x3d115377ec8e55a5c18ad620102286ecd068a36c',
  42161: '0x3d115377ec8e55a5c18ad620102286ecd068a36c',
};
const TOKEN_CONTRACTS = {
  1: '0x93a2db22b7c736b341c32ff666307f4a9ed910f5',
  10: '0x9923db8d7fbacc2e69e87fad19b886c81cd74979',
  56: '0xc9d23ed2adb0f551369946bd377f8644ce1ca5c4',
  8453: '0xc9d23ed2adb0f551369946bd377f8644ce1ca5c4',
  42161: '0xc9d23ed2adb0f551369946bd377f8644ce1ca5c4',
};
const CONFIG = JSON.parse(readFileSync('./data/config.json', 'utf8'));

if (!CONFIG.SOLVIUM_API_KEY) {
  console.error('\x1b[31mPlease configure SOLVIUM_API_KEY parameter in data/config.json\x1b[0m');
  process.exit(1);
}

const solvium = new Solvium(CONFIG.SOLVIUM_API_KEY);
const allocations = readAllocations();
const wallets = readWallets();

(async () => {
  for (const wallet of wallets) {
    try {
      await processWallet(wallet.wallet, wallet.withdrawAddress, wallet.proxy);

      await sleep(CONFIG.DELAY_SECONDS.MIN * 1000, CONFIG.DELAY_SECONDS.MAX * 1000);
    } catch {}
  }

  console.log('All wallets processed!');
})();

async function processWallet(wallet, withdrawAddress, proxy) {
  const allocation = await getAllocation(wallet.address, proxy);

  wallet = wallet.connect(PROVIDERS[allocation.chainId]);

  console.log(`[${wallet.address}] Allocation of ${ethers.formatUnits(allocation.amount, 18)} HYPER loaded!`);

  await claim(wallet, allocation);

  if (CONFIG.BRIDGE) {
    if (allocation.chainId === CONFIG.BRIDGE_DESTINATION) {
      if (withdrawAddress) {
        await withdraw(allocation.chainId, wallet, withdrawAddress);
      }

      return;
    }

    await bridge(allocation.chainId, wallet, withdrawAddress || wallet.address);

    return;
  }

  if (withdrawAddress) {
    await withdraw(allocation.chainId, wallet, withdrawAddress);
  }
}

async function withdraw(chainId, wallet, withdrawAddress) {
  const contract = getTokenContract(chainId, wallet);
  const balance = await contract.balanceOf.staticCall(wallet.address);

  if (balance <= 0n) {
    console.log(`[${wallet.address}] Nothing to withdraw!`);

    return;
  }

  console.log(`[${wallet.address}] Withdraw to ${withdrawAddress}`);

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      const transaction = await contract.transfer(withdrawAddress, balance);

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Withdraw error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Withdrawn ${ethers.formatUnits(balance, 18)} HYPER to ${withdrawAddress} successfully!\x1b[0m`);
}

async function bridge(chainId, wallet, withdrawAddress) {
  const destination = CONFIG.BRIDGE_DESTINATION;

  if (!Object.hasOwn(TOKEN_CONTRACTS, destination)) {
    throw new Error(`Unknown bridge destination ${destination}`);
  }

  const contract = getTokenContract(chainId, wallet);
  const balance = await contract.balanceOf.staticCall(wallet.address);
  const quoteGasPayment = await contract.quoteGasPayment.staticCall(destination);

  if (balance <= 0n) {
    console.log(`[${wallet.address}] Nothing to bridge!`);

    return;
  }

  console.log(`[${wallet.address}] Bridging to ${withdrawAddress} (ChainID: ${destination})`);

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      const transaction = await contract.transferRemote(
        destination,
        '0x' + withdrawAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0'),
        balance,
        {
          value: quoteGasPayment,
        },
      );

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Bridge error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Bridged ${ethers.formatUnits(balance, 18)} HYPER to ${withdrawAddress} (ChainID: ${destination}) successfully!\x1b[0m`);
}

async function claim(wallet, allocation) {
  const contract = getClaimContract(allocation.chainId, wallet);
  const isClaimed = await contract.isClaimed.staticCall(allocation.index);

  if (isClaimed) {
    console.log(`[${wallet.address}] Already claimed!`);

    return;
  }

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      const transaction = await contract.claim(allocation.index, allocation.address, allocation.amount, allocation.proof);

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Claim error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Claimed ${ethers.formatUnits(allocation.amount, 18)} HYPER successfully!\x1b[0m`);
}

async function getAllocation(address, proxy) {
  address = address.toLowerCase();

  let allocation = allocations.find((alloc) => alloc.address.toLowerCase() === address);

  if (allocation) {
    return allocation;
  }

  try {
    const sessionToken = {};
    let vcrcs;
    let body;

    for (let i = 3; i >= 0; i--) {
      const response = await gotScraping.get({
        url: 'https://claim.hyperlane.foundation/api/claims',
        searchParams: {
          address: ethers.getAddress(address),
        },
        headers: {
          Referer: 'https://claim.hyperlane.foundation/',
          Cookie: vcrcs ? `_vcrcs=${vcrcs}` : undefined,
        },
        proxyUrl: proxy,
        responseType: 'json',
        sessionToken,
      });
      const challengeToken = response.headers['x-vercel-challenge-token'];

      if (challengeToken && i) {
        console.log(`[${ethers.getAddress(address)}] Solving vercel challenge...`);

        const taskId = await solvium.createVercelTask(challengeToken);
        const solution = await solvium.getTaskResult(taskId);

        const response = await gotScraping.post({
          url: 'https://claim.hyperlane.foundation/.well-known/vercel/security/request-challenge',
          headers: {
            'x-vercel-challenge-token': challengeToken,
            'x-vercel-challenge-solution': solution,
            'x-vercel-challenge-version': '2',
          },
          sessionToken,
        });

        const cookie = response.headers['set-cookie']?.find((cookie) => cookie.startsWith('_vcrcs='));

        if (cookie) {
          vcrcs = cookie.replace(/^_vcrcs=/, '');
        }

        continue;
      }

      if (response.ok && response.body) {
        body = response.body;
        break;
      }
    }

    if (!body) {
      throw new Error(`Malformed eligibility response (status ${response.statusCode}): ` + body ?? response.rawBody?.toString('utf8'));
    }

    if (!body.response || !Array.isArray(body.response.claims) || !body.response.claims.length) {
      console.error(`\x1b[31m[${ethers.getAddress(address)}] Not eligible!\x1b[0m`);

      const err = new Error('Not eligible!');
      err.silent = true;

      throw err;
    }

    const claim = body.response.claims[0];

    allocation = {
      chainId: claim.chainId,
      index: claim.merkle.index,
      address: claim.merkle.address,
      amount: claim.merkle.amount,
      proof: claim.merkle.proof,
    };

    if (!allocation.chainId || !allocation.index || !allocation.address || !allocation.amount || !allocation.proof) {
      throw new Error(`Malformed eligibility response (status ${response.statusCode}): ` + body ?? response.rawBody?.toString('utf8'));
    }
  } catch (e) {
    if (!e.silent) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${ethers.getAddress(address)}] Allocation loading error\x1b[0m`);
      console.log();
    }

    throw e;
  }

  allocations.push(allocation);
  writeAllocations();

  return allocation;
}

function readWallets() {
  const wallets = readFileSync(new URL('./data/wallets.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);
  const proxies = readFileSync(new URL('./data/proxies.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);

  return wallets.map((wallet, index) => {
    const [privateKey, withdrawAddress] = wallet.trim().split(':');
    let proxy = proxies[index]?.trim() || undefined;

    if (proxy) {
      if (!proxy.includes('@')) {
        const [host, port, username, password] = proxy.split(':');

        proxy = `http://${username ? `${username}:${password}@` : ''}${host}:${port}`;
      }

      if (!proxy.includes('://')) {
        proxy = 'http://' + proxy;
      }

      proxy = new URL(proxy).href.replace(/\/$/, '');
    }

    return {
      wallet: new ethers.Wallet(privateKey),
      withdrawAddress: ethers.isAddress(withdrawAddress) ? withdrawAddress : undefined,
      proxy,
    };
  });

  function isNonEmptyLine(line) {
    line = line.trim();

    return line && !line.startsWith('#');
  }
}

function readAllocations() {
  try {
    const data = readFileSync(new URL('./data/allocations.json', import.meta.url), 'utf8');
    const json = JSON.parse(data);

    if (Array.isArray(json)) {
      return json;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('\x1b[33mwarn!\x1b[0m \x1b[34m[reading data/allocations.json]\x1b[0m', e.message);
    }
  }

  return [];
}

function writeAllocations() {
  const data = JSON.stringify(allocations, null, 2);

  writeFileSync(new URL('./data/allocations.json', import.meta.url), data, 'utf8');
}

function sleep(min, max) {
  const ms = max != null ? Math.floor(Math.random() * (max - min) ) + min : min;

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTokenContract(chainId, wallet) {
  if (!Object.hasOwn(TOKEN_CONTRACTS, chainId)) {
    throw new Error(`Unknown chainId ${chainId}`);
  }

  const ABI = JSON.parse('[{"inputs":[{"internalType":"uint8","name":"__decimals","type":"uint8"},{"internalType":"uint256","name":"_scale","type":"uint256"},{"internalType":"address","name":"_mailbox","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"},{"indexed":true,"internalType":"address","name":"spender","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[],"name":"EIP712DomainChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint32","name":"domain","type":"uint32"},{"indexed":false,"internalType":"uint256","name":"gas","type":"uint256"}],"name":"GasSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"_hook","type":"address"}],"name":"HookSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint8","name":"version","type":"uint8"}],"name":"Initialized","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"_ism","type":"address"}],"name":"IsmSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint32","name":"origin","type":"uint32"},{"indexed":true,"internalType":"bytes32","name":"recipient","type":"bytes32"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"ReceivedTransferRemote","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint32","name":"destination","type":"uint32"},{"indexed":true,"internalType":"bytes32","name":"recipient","type":"bytes32"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"SentTransferRemote","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"from","type":"address"},{"indexed":true,"internalType":"address","name":"to","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Transfer","type":"event"},{"inputs":[],"name":"DOMAIN_SEPARATOR","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"PACKAGE_VERSION","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"subtractedValue","type":"uint256"}],"name":"decreaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint32","name":"","type":"uint32"}],"name":"destinationGas","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"domains","outputs":[{"internalType":"uint32[]","name":"","type":"uint32[]"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"eip712Domain","outputs":[{"internalType":"bytes1","name":"fields","type":"bytes1"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"version","type":"string"},{"internalType":"uint256","name":"chainId","type":"uint256"},{"internalType":"address","name":"verifyingContract","type":"address"},{"internalType":"bytes32","name":"salt","type":"bytes32"},{"internalType":"uint256[]","name":"extensions","type":"uint256[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"_domain","type":"uint32"},{"internalType":"bytes32","name":"_router","type":"bytes32"}],"name":"enrollRemoteRouter","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint32[]","name":"_domains","type":"uint32[]"},{"internalType":"bytes32[]","name":"_addresses","type":"bytes32[]"}],"name":"enrollRemoteRouters","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint32","name":"_origin","type":"uint32"},{"internalType":"bytes32","name":"_sender","type":"bytes32"},{"internalType":"bytes","name":"_message","type":"bytes"}],"name":"handle","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"hook","outputs":[{"internalType":"contract IPostDispatchHook","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"addedValue","type":"uint256"}],"name":"increaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_totalSupply","type":"uint256"},{"internalType":"string","name":"_name","type":"string"},{"internalType":"string","name":"_symbol","type":"string"},{"internalType":"address","name":"_hook","type":"address"},{"internalType":"address","name":"_interchainSecurityModule","type":"address"},{"internalType":"address","name":"_owner","type":"address"}],"name":"initialize","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"interchainSecurityModule","outputs":[{"internalType":"contract IInterchainSecurityModule","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"localDomain","outputs":[{"internalType":"uint32","name":"","type":"uint32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"mailbox","outputs":[{"internalType":"contract IMailbox","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"nonces","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint8","name":"v","type":"uint8"},{"internalType":"bytes32","name":"r","type":"bytes32"},{"internalType":"bytes32","name":"s","type":"bytes32"}],"name":"permit","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint32","name":"_destinationDomain","type":"uint32"}],"name":"quoteGasPayment","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint32","name":"_domain","type":"uint32"}],"name":"routers","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"scale","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"domain","type":"uint32"},{"internalType":"uint256","name":"gas","type":"uint256"}],"name":"setDestinationGas","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"domain","type":"uint32"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct GasRouter.GasRouterConfig[]","name":"gasConfigs","type":"tuple[]"}],"name":"setDestinationGas","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_hook","type":"address"}],"name":"setHook","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_module","type":"address"}],"name":"setInterchainSecurityModule","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint32","name":"_destination","type":"uint32"},{"internalType":"bytes32","name":"_recipient","type":"bytes32"},{"internalType":"uint256","name":"_amountOrId","type":"uint256"},{"internalType":"bytes","name":"_hookMetadata","type":"bytes"},{"internalType":"address","name":"_hook","type":"address"}],"name":"transferRemote","outputs":[{"internalType":"bytes32","name":"messageId","type":"bytes32"}],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint32","name":"_destination","type":"uint32"},{"internalType":"bytes32","name":"_recipient","type":"bytes32"},{"internalType":"uint256","name":"_amountOrId","type":"uint256"}],"name":"transferRemote","outputs":[{"internalType":"bytes32","name":"messageId","type":"bytes32"}],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint32","name":"_domain","type":"uint32"}],"name":"unenrollRemoteRouter","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint32[]","name":"_domains","type":"uint32[]"}],"name":"unenrollRemoteRouters","outputs":[],"stateMutability":"nonpayable","type":"function"}]');

  return new ethers.Contract(TOKEN_CONTRACTS[chainId], ABI, wallet);
}

function getClaimContract(chainId, wallet) {
  if (!Object.hasOwn(CLAIM_CONTRACTS, chainId)) {
    throw new Error(`Unknown chainId ${chainId}`);
  }

  const ABI = JSON.parse('[{"inputs":[{"internalType":"address","name":"token_","type":"address"},{"internalType":"bytes32","name":"merkleRoot_","type":"bytes32"},{"internalType":"uint256","name":"endTime_","type":"uint256"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"AlreadyClaimed","type":"error"},{"inputs":[],"name":"ClaimWindowFinished","type":"error"},{"inputs":[],"name":"EndTimeInPast","type":"error"},{"inputs":[],"name":"InvalidProof","type":"error"},{"inputs":[],"name":"NoWithdrawDuringClaim","type":"error"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"index","type":"uint256"},{"indexed":false,"internalType":"address","name":"account","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"Claimed","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"inputs":[{"internalType":"uint256","name":"index","type":"uint256"},{"internalType":"address","name":"account","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"}],"name":"claim","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"endTime","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"index","type":"uint256"}],"name":"isClaimed","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"merkleRoot","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"token","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"}]');

  return new ethers.Contract(CLAIM_CONTRACTS[chainId], ABI, wallet);
}
