import { cborDecode, getMonitoredChains, MonitorConfig } from "@ethereum-sourcify/core";
import { Injector } from "@ethereum-sourcify/verification";
import Logger from "bunyan";
import Web3 from "web3";
import { Transaction } from "web3-core";
import { SourceAddress } from "./util";
import { ethers } from "ethers";
import dotenv from 'dotenv';
import path from 'path';
import SourceFetcher from "./source-fetcher";
dotenv.config({ path: path.resolve(__dirname, "..", "..", "environments/.env") });

const BLOCK_PAUSE_FACTOR = parseInt(process.env.BLOCK_PAUSE_FACTOR) || 1.1;
const BLOCK_PAUSE_UPPER_LIMIT = parseInt(process.env.BLOCK_PAUSE_UPPER_LIMIT) || (30 * 1000); // default: 30 seconds
const BLOCK_PAUSE_LOWER_LIMIT = parseInt(process.env.BLOCK_PAUSE_LOWER_LIMIT) || (0.5 * 1000); // default: 0.5 seconds

function createsContract(tx: Transaction): boolean {
    return !tx.to;
}

class ChainMonitor {
    private chainId: string;
    private web3Provider: Web3;
    private sourceFetcher: SourceFetcher;
    private logger: Logger;
    private injector: Injector;

    private getBytecodeRetryPause: number;
    private getBlockPause: number;
    private initialGetBytecodeTries: number;

    constructor(name: string, chainId: string, web3Url: string, sourceFetcher: SourceFetcher, injector: Injector) {
        this.chainId = chainId;
        this.web3Provider = new Web3(web3Url);
        this.sourceFetcher = sourceFetcher;
        this.logger = new Logger({ name });
        this.injector = injector;

        this.getBytecodeRetryPause = parseInt(process.env.GET_BYTECODE_RETRY_PAUSE) || (5 * 1000);
        this.getBlockPause = parseInt(process.env.GET_BLOCK_PAUSE) || (10 * 1000);
        this.initialGetBytecodeTries = parseInt(process.env.INITIAL_GET_BYTECODE_TRIES) || 3;
    }

    start = async (): Promise<void> => {
        const rawStartBlock = process.env[`MONITOR_START_${this.chainId}`];
        const startBlock = parseInt(rawStartBlock) || await this.web3Provider.eth.getBlockNumber();
        this.processBlock(startBlock);
        this.logger.info({ loc: "[MONITOR_START]", startBlock }, "Starting monitor");
    }

    private processBlock = (blockNumber: number) => {
        this.web3Provider.eth.getBlock(blockNumber, true).then(block => {
            if (!block) {
                this.getBlockPause *= BLOCK_PAUSE_FACTOR;
                this.getBlockPause = Math.min(this.getBlockPause, BLOCK_PAUSE_UPPER_LIMIT);

                const logObject = { loc: "[PROCESS_BLOCK]", blockNumber, getBlockPause: this.getBlockPause };
                this.logger.info(logObject, "Waiting for new blocks");
                return;

            } else {
                this.getBlockPause /= BLOCK_PAUSE_FACTOR;
                this.getBlockPause = Math.max(this.getBlockPause, BLOCK_PAUSE_LOWER_LIMIT);
            }

            for (const tx of block.transactions) {
                if (createsContract(tx)) {
                    const address = ethers.utils.getContractAddress(tx);
                    this.processBytecode(address, this.initialGetBytecodeTries);
                }
            }

            blockNumber++;

        }).catch(err => {
            this.logger.error({ loc: "[PROCESS_BLOCK:FAILED]", blockNumber }, err.message);
        }).finally(() => {
            setTimeout(this.processBlock, this.getBlockPause, blockNumber);
        });
    }

    private processBytecode = (address: string, retriesLeft: number): void => {
        if (retriesLeft-- <= 0) {
            return;
        }

        this.web3Provider.eth.getCode(address).then(bytecode => {
            if (bytecode === "0x") {
                this.logger.info({ loc: "[PROCESS_BYTECODE]", address, retriesLeft }, "Empty bytecode");
                setTimeout(this.processBytecode, this.getBytecodeRetryPause, address, retriesLeft);
                return;
            }

            const numericBytecode = Web3.utils.hexToBytes(bytecode);
            try {
                const cborData = cborDecode(numericBytecode);
                const metadataAddress = SourceAddress.fromCborData(cborData);
                this.sourceFetcher.assemble(metadataAddress, contract => {
                    const logObject = { loc: "[PROCESS_BYTECODE]", contract: contract.name, address };
                    this.injector.inject({
                        contract,
                        bytecode,
                        chain: this.chainId,
                        addresses: [address]
                    }).then(() => this.logger.info(logObject, "Successfully injected")
                    ).catch(err => this.logger.error(logObject, err.message));
                });
            } catch(err) {
                this.logger.error({ loc: "[GET_BYTECODE:METADATA_READING]", address }, err.message);
            }

        }).catch(err => {
            this.logger.error({ loc: "[GET_BYTECODE]", address, retriesLeft }, err.message);
            setTimeout(this.processBytecode, this.getBytecodeRetryPause, address, retriesLeft);
        });
    }
}

export default class Monitor {
    private chainMonitors: ChainMonitor[];
    private injector: Injector;

    constructor(config: MonitorConfig) {
        this.injector = Injector.createOffline({
            log: new Logger({ name: "Monitor" }),
            repositoryPath: config.repository
        });
    }

    start = (): void => {
        const sourceFetcher = new SourceFetcher();
        if (process.env.TESTING === "true") {
            throw new Error("Testing not yet supported");

        } else {
            const chains = getMonitoredChains();
            this.chainMonitors = chains.map((chain: any) => new ChainMonitor(
                chain.name,
                chain.chainId.toString(),
                chain.web3[0].replace("${INFURA_API_KEY}", process.env.INFURA_ID),
                sourceFetcher,
                this.injector
            ));
        }

        this.chainMonitors.forEach(chainMonitor => chainMonitor.start());
    }
}