require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const randomUseragent = require('random-useragent');
const axios = require('axios');

const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
  bright: '\x1b[1m',
};

const logger = {
  info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
  wallet: (msg) => console.log(`${colors.yellow}[➤] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[!] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[+] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.white}[➤] ${msg}${colors.reset}`),
  banner: () => {
    console.log(`${colors.blue}${colors.bold}`);
    console.log('████████ ███████ ███      ███ ████████ ███████ ██   ██    ██       █████  ██   ██  █████  ████████ ');
    console.log('██    ██ ██      ████    ████ ██    ██ ██      ██  ██     ██      ██   ██ ██   ██ ██   ██    ██    ');
    console.log('████████ █████   ██ ██  ██ ██ ████████ █████   █████      ██      ███████ ███████ ███████    ██    ');
    console.log('██       ██      ██   ██   ██ ██       ██      ██  ██     ██      ██   ██ ██   ██ ██   ██    ██    ');
    console.log('██       ███████ ██        ██ ██       ███████ ██   ██    ███████ ██   ██ ██   ██ ██   ██    ██    ');
    console.log('                                                                                                  ');
    console.log('                                                                                                  ');
  },
};

const networkConfig = {
  name: 'Pharos Testnet',
  chainId: 688688,
  rpcUrl: 'https://testnet.dplabs-internal.com',
  currencySymbol: 'PHRS',
};

const tokens = {
  USDC: '0xad902cf99c2de2f1ba5ec4d642fd7e49cae9ee37',
  WPHRS: '0x76aaada469d23216be5f7c596fa25f282ff9b364',
};

const contractAddress = '0x1a4de519154ae51200b0ad7c90f7fac75547888a';

const tokenDecimals = {
  WPHRS: 18,
  USDC: 6,
};

const contractAbi = [
  'function multicall(uint256 deadlineOrFlags, bytes[] calldata data) payable',
];

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) public returns (bool)',
];

const loadProxies = () => {
  try {
    const proxies = fs.readFileSync('proxies.txt', 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line);
    return proxies;
  } catch (error) {
    logger.warn('No proxies.txt found or failed to load, switching to direct mode');
    return [];
  }
};

const getRandomProxy = (proxies) => {
  return proxies[Math.floor(Math.random() * proxies.length)];
};

const setupProvider = (proxy = null) => {
  if (proxy) {
    logger.info(`Using proxy: ${proxy}`);
    const agent = new HttpsProxyAgent(proxy);
    return new ethers.JsonRpcProvider(networkConfig.rpcUrl, {
      chainId: networkConfig.chainId,
      name: networkConfig.name,
    }, {

    });
  } else {
    logger.info('Using direct mode (no proxy)');
    return new ethers.JsonRpcProvider(networkConfig.rpcUrl, {
      chainId: networkConfig.chainId,
      name: networkConfig.name,
    });
  }
};

const pairOptions = [
  { id: 1, from: 'WPHRS', to: 'USDC' },
  { id: 2, from: 'USDC', to: 'WPHRS' },
];

const checkBalanceAndApproval = async (wallet, tokenAddress, tokenSymbol, amount, decimals, spender) => {
  try {
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
    const required = ethers.parseUnits(amount.toString(), decimals);

    const allowance = await tokenContract.allowance(wallet.address, spender);
    if (allowance < required) {
      logger.step(`Approving ${amount} ${tokenSymbol} for spender ${spender}...`);
      const approveTx = await tokenContract.approve(spender, ethers.MaxUint256);
      await approveTx.wait();
      logger.success(`Approval for ${tokenSymbol} completed.`);
    } else {
      logger.info(`Sufficient allowance already granted for ${tokenSymbol}.`);
    }
    return true;
  } catch (error) {
    logger.error(`Approval check/process failed for ${tokenSymbol}: ${error.message}`);
    return false;
  }
};

const getMulticallData = (pair, amount, walletAddress) => {
  try {
    const fromTokenSymbol = pair.from;
    const toTokenSymbol = pair.to;
    const decimals = tokenDecimals[fromTokenSymbol];
    const scaledAmount = ethers.parseUnits(amount.toString(), decimals);

    const subCallDeadline = ethers.toBigInt(Math.floor(Date.now() / 1000) + 300);
    const swapFunctionSelector = '0x04e45aaf';
    
    let innerCallData;

    if (fromTokenSymbol === 'WPHRS' && toTokenSymbol === 'USDC') {
      innerCallData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'uint24', 'address', 'uint256', 'uint256', 'uint160'],
        [
          tokens.WPHRS,
          tokens.USDC,
          500,
          walletAddress,
          scaledAmount,
          ethers.toBigInt(0),
          ethers.toBigInt(0),
        ]
      );
    } else if (fromTokenSymbol === 'USDC' && toTokenSymbol === 'WPHRS') {
      innerCallData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'uint24', 'address', 'uint256', 'uint256', 'uint160'],
        [
          tokens.USDC,
          tokens.WPHRS,
          500,
          walletAddress,
          scaledAmount,
          ethers.toBigInt(0),
          ethers.toBigInt(0),
        ]
      );
      
    } else {
      logger.error(`Invalid pair: ${fromTokenSymbol} -> ${toTokenSymbol}`);
      return [];
    }
    return [ethers.concat([swapFunctionSelector, innerCallData])];

  } catch (error)
{
    logger.error(`Failed to generate multicall data: ${error.message}`);
    if (error.stack) {
        logger.error(error.stack);
    }
    return [];
  }
};

const performSwap = async (wallet, provider, swapIndex) => {
  try {
    const pair = pairOptions[Math.floor(Math.random() * pairOptions.length)];
    const amount = pair.from === 'WPHRS' ? 0.001 : 0.1;
    const fromTokenSymbol = pair.from;
    const toTokenSymbol = pair.to;

    logger.step(`[Swap ${swapIndex + 1}] Preparing: ${amount} ${fromTokenSymbol} -> ${toTokenSymbol}`);

    const decimals = tokenDecimals[fromTokenSymbol];
    const fromTokenAddress = tokens[fromTokenSymbol];

    const tokenContractForBalance = new ethers.Contract(fromTokenAddress, erc20Abi, provider);
    const balance = await tokenContractForBalance.balanceOf(wallet.address);
    const requiredAmount = ethers.parseUnits(amount.toString(), decimals);

    if (balance < requiredAmount) {
      logger.warn(`[Swap ${swapIndex + 1}] Skipping: Insufficient ${fromTokenSymbol} balance. Have: ${ethers.formatUnits(balance, decimals)}, Need: ${amount}`);
      return;
    }
    logger.info(`[Swap ${swapIndex + 1}] ${fromTokenSymbol} balance sufficient: ${ethers.formatUnits(balance, decimals)}`);

    if (!(await checkBalanceAndApproval(wallet, fromTokenAddress, fromTokenSymbol, amount, decimals, contractAddress))) {
      return;
    }

    const multicallPayload = getMulticallData(pair, amount, wallet.address);
    if (!multicallPayload || multicallPayload.length === 0 || multicallPayload.some(data => !data || data === '0x')) {
      logger.error(`[Swap ${swapIndex + 1}] Invalid or empty multicall data for ${fromTokenSymbol} -> ${toTokenSymbol}.`);
      return;
    }
    logger.info(`[Swap ${swapIndex + 1}] Multicall payload generated: ${multicallPayload[0].substring(0, 50)}...`);


    const mainContract = new ethers.Contract(contractAddress, contractAbi, wallet);
    const gasLimit = ethers.toBigInt(250000);
    
    const multicallDeadlineOrFlags = ethers.toBigInt(Math.floor(Date.now() / 1000) + 300);


    logger.loading(`[Swap ${swapIndex + 1}] Sending multicall transaction with deadline/flags: ${multicallDeadlineOrFlags.toString()}`);
    
    const tx = await mainContract['multicall'](
      multicallDeadlineOrFlags,
      multicallPayload,
      {
        gasLimit: gasLimit,
        gasPrice: ethers.toBigInt(0),
      }
    );

    logger.loading(`[Swap ${swapIndex + 1}] Transaction sent (${tx.hash}). Waiting for confirmation...`);
    const receipt = await tx.wait(1);

    if (receipt && receipt.status === 1) {
      logger.success(`[Swap ${swapIndex + 1}] COMPLETED! TxHash: ${receipt.hash}`);
    } else {
      logger.error(`[Swap ${swapIndex + 1}] FAILED ON-CHAIN. TxHash: ${receipt ? receipt.hash : 'N/A'}`);
      if (receipt) {
        logger.error(`  Receipt Status: ${receipt.status}`);
        logger.error(`  Block Number: ${receipt.blockNumber}`);
        logger.error(`  Gas Used: ${receipt.gasUsed.toString()}`);
      }
       try {
       } catch (e) {
       }
    }

  } catch (error) {
    logger.error(`[Swap ${swapIndex + 1}] FAILED: ${error.message}`);
    if (error.code === 'CALL_EXCEPTION') {
        logger.error('  Reason: Transaction reverted.');
        if (error.transaction) {
             logger.error(`    TX Data: to=${error.transaction.to}, from=${error.transaction.from}, data=${error.transaction.data ? error.transaction.data.substring(0,100)+'...' : 'N/A'}`);
        }
        if (error.receipt) {
            logger.error(`    Receipt: hash=${error.receipt.hash}, status=${error.receipt.status}`);
        }
        if (error.reason) { 
            logger.error(`    Revert Reason from error object: ${error.reason}`);
        }
    } else if (error.transactionHash) {
        logger.error(`  Transaction Hash: ${error.transactionHash}`);
    }
    
    if (process.env.DEBUG_FULL_ERROR === 'true' && error.stack) {
        logger.error(`Stack trace: ${error.stack}`);
    }
  }
};

const transferPHRS = async (wallet, provider, transferIndex) => {
  try {
    const min = 0.000009;
    const max = 0.001000;
    const amount = parseFloat((Math.random() * (max - min) + min).toFixed(18));

    const randomWallet = ethers.Wallet.createRandom();
    const toAddress = randomWallet.address;
    logger.step(`[Transfer ${transferIndex + 1}] Preparing: ${amount.toFixed(6)} PHRS to ${toAddress}`);

    const balance = await provider.getBalance(wallet.address);
    const required = ethers.parseEther(amount.toFixed(18));

    if (balance < required) {
      logger.warn(`[Transfer ${transferIndex + 1}] Skipping: Insufficient PHRS balance. Have: ${ethers.formatEther(balance)}, Need: ${amount.toFixed(6)}`);
      return;
    }

    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: required,
      gasLimit: ethers.toBigInt(21000),
      gasPrice: ethers.toBigInt(0),
    });

    logger.loading(`[Transfer ${transferIndex + 1}] Transaction sent (${tx.hash}). Waiting for confirmation...`);
    const receipt = await tx.wait(1);

    if (receipt && receipt.status === 1) {
      logger.success(`[Transfer ${transferIndex + 1}] COMPLETED! TxHash: ${receipt.hash}`);
    } else {
      logger.error(`[Transfer ${transferIndex + 1}] FAILED ON-CHAIN. TxHash: ${receipt ? receipt.hash : 'N/A'}`);
    }
  } catch (error) {
    logger.error(`[Transfer ${transferIndex + 1}] FAILED: ${error.message}`);
    if (error.code === 'CALL_EXCEPTION' && error.reason) {
        logger.error(`  Revert Reason: ${error.reason}`);
    }
  }
};

const claimFaucet = async (wallet, proxy = null) => {
  try {
    logger.step(`Checking faucet eligibility for wallet: ${wallet.address}`);

    const message = "pharos";
    const signature = await wallet.signMessage(message);

    const loginUrl = `https://api.pharosnetwork.xyz/user/login?address=${wallet.address}&signature=${signature}&invite_code=S6NGMzXSCDBxhnwo`;
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.8",
      authorization: "Bearer null",
      "sec-ch-ua": '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
      Referer: "https://testnet.pharosnetwork.xyz/",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "User-Agent": randomUseragent.getRandom(),
    };

    const axiosConfig = {
      method: 'post',
      url: loginUrl,
      headers,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: 15000,
    };

    logger.loading('Sending login request for faucet...');
    const loginResponse = await axios(axiosConfig);
    const loginData = loginResponse.data;

    if (loginData.code !== 0 || !loginData.data || !loginData.data.jwt) {
      logger.error(`Login failed for faucet: ${loginData.msg || 'Unknown error or no JWT'}`);
      return false;
    }

    const jwt = loginData.data.jwt;


    const statusUrl = `https://api.pharosnetwork.xyz/faucet/status?address=${wallet.address}`;
    const statusHeaders = {
      ...headers,
      authorization: `Bearer ${jwt}`,
    };

    logger.loading('Checking faucet status...');
    const statusResponse = await axios({
      method: 'get',
      url: statusUrl,
      headers: statusHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: 15000,
    });
    const statusData = statusResponse.data;

    if (statusData.code !== 0 || !statusData.data) {
      logger.error(`Faucet status check failed: ${statusData.msg || 'Unknown error or no data'}`);
      return false;
    }

    if (!statusData.data.is_able_to_faucet) {
      const nextAvailable = new Date(statusData.data.avaliable_timestamp * 1000).toLocaleString('en-US', { timeZone: 'Asia/Makassar' });
      logger.warn(`Faucet not available until: ${nextAvailable}`);
      return false;
    }

    const claimUrl = `https://api.pharosnetwork.xyz/faucet/daily?address=${wallet.address}`;
    logger.loading('Claiming faucet...');
    const claimResponse = await axios({
      method: 'post',
      url: claimUrl,
      headers: statusHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: 15000,
    });
    const claimData = claimResponse.data;

    if (claimData.code === 0) {
      logger.success(`Faucet claimed successfully for ${wallet.address}`);
      return true;
    } else {
      logger.error(`Faucet claim failed: ${claimData.msg || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    logger.error(`Faucet claim process failed for ${wallet.address}: ${error.message}`);
    if (error.response && error.response.data) {
        logger.error(`Faucet API Error: ${JSON.stringify(error.response.data)}`);
    }
    return false;
  }
};

const performCheckIn = async (wallet, proxy = null) => {
  try {
    logger.step(`Performing daily check-in for wallet: ${wallet.address}`);

    const message = "pharos";
    const signature = await wallet.signMessage(message);


    const loginUrl = `https://api.pharosnetwork.xyz/user/login?address=${wallet.address}&signature=${signature}&invite_code=S6NGMzXSCDBxhnwo`;
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.8",
      authorization: "Bearer null",
      "sec-ch-ua": '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
      Referer: "https://testnet.pharosnetwork.xyz/",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "User-Agent": randomUseragent.getRandom(),
    };

    const axiosConfig = {
      method: 'post',
      url: loginUrl,
      headers,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: 15000,
    };

    logger.loading('Sending login request for check-in...');
    const loginResponse = await axios(axiosConfig);
    const loginData = loginResponse.data;

    if (loginData.code !== 0 || !loginData.data || !loginData.data.jwt) {
      logger.error(`Login failed for check-in: ${loginData.msg || 'Unknown error or no JWT'}`);
      return false;
    }

    const jwt = loginData.data.jwt;


    const checkInUrl = `https://api.pharosnetwork.xyz/sign/in?address=${wallet.address}`;
    const checkInHeaders = {
      ...headers,
      authorization: `Bearer ${jwt}`,
    };

    logger.loading('Sending check-in request...');
    const checkInResponse = await axios({
      method: 'post',
      url: checkInUrl,
      headers: checkInHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: 15000,
    });
    const checkInData = checkInResponse.data;

    if (checkInData.code === 0) {
      logger.success(`Check-in successful for ${wallet.address}`);
      return true;
    } else {
      const alreadyCheckedInMessage = "you have already signed in today";
      if (checkInData.msg && checkInData.msg.toLowerCase().includes(alreadyCheckedInMessage)) {
        logger.warn(`Already checked in today for ${wallet.address}.`);
      } else {
        logger.warn(`Check-in failed/not successful: ${checkInData.msg || 'Unknown error'}`);
      }
      return false;
    }
  } catch (error) {
    logger.error(`Check-in process failed for ${wallet.address}: ${error.message}`);
    if (error.response && error.response.data) {
        logger.error(`Check-in API Error: ${JSON.stringify(error.response.data)}`);
    }
    return false;
  }
};

const countdown = async (durationSeconds = 30 * 60) => {
  logger.info(`Starting countdown for ${durationSeconds / 60} minutes...`);

  for (let seconds = durationSeconds; seconds >= 0; seconds--) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    process.stdout.write(`\r${colors.cyan}Time remaining: ${minutes}m ${secs}s${colors.reset} `);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  process.stdout.write('\rCountdown complete! Restarting process...\n');
};

const main = async () => {
  logger.banner();

  const proxies = loadProxies();

const MAX_KEYS = 15;

const privateKeys = [];
for (let i = 1; i <= MAX_KEYS; i++) {
  const key = process.env[`PRIVATE_KEY_${i}`];
  if (key && key.trim() !== '') {
    privateKeys.push(key.trim());
  }
}

if (!privateKeys.length) {
  logger.error('Tidak ditemukan private key yang valid di .env. Pastikan PRIVATE_KEY_1 hingga PRIVATE_KEY_15 sudah diatur.');
  return;
}

logger.info(`Berhasil memuat ${privateKeys.length} private key.`);

if (proxies.length > 0) {
  logger.info(`Berhasil memuat ${proxies.length} proxy.`);
} else {
  logger.warn('Berjalan dalam mode langsung (tanpa proxy).');
}

  const numSwapsPerWallet = parseInt(process.env.NUM_SWAPS_PER_WALLET) || 5;
  const isSwapEnabled = process.env.ENABLE_SWAP?.toLowerCase() === 'true';
  const numTransfersPerWallet = parseInt(process.env.NUM_TRANSFERS_PER_WALLET) || 5;
  const delayBetweenActionsMs = (parseInt(process.env.DELAY_ACTIONS_SEC) || 5) * 1000;
  const delayBetweenWalletsMs = (parseInt(process.env.DELAY_WALLETS_SEC) || 25) * 1000;
  const mainLoopDelayMinutes = parseInt(process.env.MAIN_LOOP_DELAY_MIN) || 30;

  logger.info(`Configuration: Swaps/wallet=${numSwapsPerWallet}, Transfers/wallet=${numTransfersPerWallet}, ActionDelay=${delayBetweenActionsMs/1000}s, WalletDelay=${delayBetweenWalletsMs/1000}s, LoopDelay=${mainLoopDelayMinutes}min`);


  let walletIndex = 0;
  while (true) {
    for (const privateKey of privateKeys) {
      walletIndex++;
      logger.info(`\n--- Processing Wallet ${walletIndex}/${privateKeys.length} ---`);
      const proxy = proxies.length ? getRandomProxy(proxies) : null;
      const provider = setupProvider(proxy);
      const wallet = new ethers.Wallet(privateKey, provider);

      logger.wallet(`Using wallet: ${wallet.address}`);

      await claimFaucet(wallet, proxy);
      await new Promise(resolve => setTimeout(resolve, delayBetweenActionsMs));

      await performCheckIn(wallet, proxy);
      await new Promise(resolve => setTimeout(resolve, delayBetweenActionsMs));

      logger.step(`Starting ${numTransfersPerWallet} PHRS transfers...`);
      for (let i = 0; i < numTransfersPerWallet; i++) {
        await transferPHRS(wallet, provider, i);
        if (i < numTransfersPerWallet - 1) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenActionsMs));
        }
      }
      logger.success(`${numTransfersPerWallet} PHRS transfers attempted.`);
      await new Promise(resolve => setTimeout(resolve, delayBetweenActionsMs));


      if (isSwapEnabled) {
  logger.step(`Starting ${numSwapsPerWallet} token swaps...`);
  for (let i = 0; i < numSwapsPerWallet; i++) {
    await performSwap(wallet, provider, i);
    if (i < numSwapsPerWallet - 1) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenActionsMs));
    }
  }
  logger.success(`${numSwapsPerWallet} token swaps attempted.`);
} else {
  logger.warn('Token swap is disabled by configuration (ENABLE_SWAP=false). Skipping swap step.');
}
      
      if (privateKeys.length > 1 && walletIndex < privateKeys.length) {
        logger.info(`Waiting ${delayBetweenWalletsMs/1000} seconds before next wallet...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenWalletsMs));
      }
    }
    walletIndex = 0;
    logger.success('All actions completed for all wallets in this cycle!');
    await countdown(mainLoopDelayMinutes * 60);
  }
};

main().catch(error => {
  logger.error(`Bot encountered a critical failure: ${error.message}`);
  if (error.stack) {
    logger.error(error.stack);
  }
  process.exit(1);
});