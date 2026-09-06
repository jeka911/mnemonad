/**
 * ABI of the MnemonadUploadGateway contract.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node sync_abi.js (from scripts/)
 */
export const uploadGatewayAbi = [
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "mnemonad_",
				"type": "address"
			},
			{
				"internalType": "address",
				"name": "pyth_",
				"type": "address"
			},
			{
				"internalType": "bytes32",
				"name": "priceFeedId_",
				"type": "bytes32"
			},
			{
				"internalType": "address",
				"name": "owner_",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "usdCentsPerMiB_",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "minChargeWei_",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "minWeiPerMiB_",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "maxWeiPerMiB_",
				"type": "uint256"
			}
		],
		"stateMutability": "nonpayable",
		"type": "constructor"
	},
	{
		"inputs": [],
		"name": "AmountTooLarge",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "minWeiPerMiB",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "maxWeiPerMiB",
				"type": "uint256"
			}
		],
		"name": "BadBand",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "int32",
				"name": "expo",
				"type": "int32"
			}
		],
		"name": "BadExponent",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "int64",
				"name": "price",
				"type": "int64"
			}
		],
		"name": "BadPrice",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "maxWeiPerMiB",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "ceiling",
				"type": "uint256"
			}
		],
		"name": "BandAboveMax",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "uint64",
				"name": "conf",
				"type": "uint64"
			},
			{
				"internalType": "int64",
				"name": "price",
				"type": "int64"
			}
		],
		"name": "ConfidenceTooWide",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "EmptySize",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "required",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "provided",
				"type": "uint256"
			}
		],
		"name": "InsufficientPayment",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "uint64",
				"name": "expiry",
				"type": "uint64"
			}
		],
		"name": "NotExpired",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "NotMnemonad",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "owner",
				"type": "address"
			}
		],
		"name": "OwnableInvalidOwner",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "account",
				"type": "address"
			}
		],
		"name": "OwnableUnauthorizedAccount",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "PricingUnset",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "weiPerMiB",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "min",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "max",
				"type": "uint256"
			}
		],
		"name": "RateOutOfBand",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "ReentrancyGuardReentrantCall",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "requestId",
				"type": "bytes32"
			}
		],
		"name": "RequestExists",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "SalesPaused",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "TransferFailed",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "requestId",
				"type": "bytes32"
			}
		],
		"name": "UnknownRequest",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "ZeroAddress",
		"type": "error"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "maxPriceAge",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "maxConfBps",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "requestTtl",
				"type": "uint256"
			}
		],
		"name": "LimitsSet",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": false,
				"internalType": "address",
				"name": "pyth",
				"type": "address"
			},
			{
				"indexed": false,
				"internalType": "bytes32",
				"name": "priceFeedId",
				"type": "bytes32"
			}
		],
		"name": "OracleSet",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "address",
				"name": "previousOwner",
				"type": "address"
			},
			{
				"indexed": true,
				"internalType": "address",
				"name": "newOwner",
				"type": "address"
			}
		],
		"name": "OwnershipTransferStarted",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "address",
				"name": "previousOwner",
				"type": "address"
			},
			{
				"indexed": true,
				"internalType": "address",
				"name": "newOwner",
				"type": "address"
			}
		],
		"name": "OwnershipTransferred",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": false,
				"internalType": "bool",
				"name": "paused",
				"type": "bool"
			}
		],
		"name": "PausedSet",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "usdCentsPerMiB",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "minChargeWei",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "minWeiPerMiB",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "maxWeiPerMiB",
				"type": "uint256"
			}
		],
		"name": "PricingSet",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "address",
				"name": "to",
				"type": "address"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "amount",
				"type": "uint256"
			}
		],
		"name": "RevenueWithdrawn",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "requestId",
				"type": "bytes32"
			},
			{
				"indexed": true,
				"internalType": "address",
				"name": "payer",
				"type": "address"
			},
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "contentHash",
				"type": "bytes32"
			},
			{
				"indexed": false,
				"internalType": "uint64",
				"name": "size",
				"type": "uint64"
			}
		],
		"name": "UploadConsumed",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "requestId",
				"type": "bytes32"
			},
			{
				"indexed": true,
				"internalType": "address",
				"name": "payer",
				"type": "address"
			},
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "contentHash",
				"type": "bytes32"
			},
			{
				"indexed": false,
				"internalType": "uint64",
				"name": "maxSize",
				"type": "uint64"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "amount",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "uint64",
				"name": "expiry",
				"type": "uint64"
			}
		],
		"name": "UploadPaid",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "requestId",
				"type": "bytes32"
			},
			{
				"indexed": true,
				"internalType": "address",
				"name": "payer",
				"type": "address"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "amount",
				"type": "uint256"
			}
		],
		"name": "UploadRefunded",
		"type": "event"
	},
	{
		"inputs": [],
		"name": "MAX_WEI_PER_MIB",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "acceptOwnership",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "payer",
				"type": "address"
			},
			{
				"internalType": "bytes32",
				"name": "contentHash",
				"type": "bytes32"
			},
			{
				"internalType": "uint64",
				"name": "size",
				"type": "uint64"
			}
		],
		"name": "consumeUpload",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "escrowed",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "maxConfBps",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "maxPriceAge",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "maxWeiPerMiB",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "minChargeWei",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "minWeiPerMiB",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "mnemonad",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "owner",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "paused",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "contentHash",
				"type": "bytes32"
			},
			{
				"internalType": "uint64",
				"name": "maxSize",
				"type": "uint64"
			}
		],
		"name": "payForUpload",
		"outputs": [
			{
				"internalType": "bytes32",
				"name": "requestId",
				"type": "bytes32"
			}
		],
		"stateMutability": "payable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes[]",
				"name": "updateData",
				"type": "bytes[]"
			},
			{
				"internalType": "bytes32",
				"name": "contentHash",
				"type": "bytes32"
			},
			{
				"internalType": "uint64",
				"name": "maxSize",
				"type": "uint64"
			}
		],
		"name": "payForUploadWithUpdate",
		"outputs": [
			{
				"internalType": "bytes32",
				"name": "requestId",
				"type": "bytes32"
			}
		],
		"stateMutability": "payable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "pendingOwner",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "priceFeedId",
		"outputs": [
			{
				"internalType": "bytes32",
				"name": "",
				"type": "bytes32"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes[]",
				"name": "updateData",
				"type": "bytes[]"
			}
		],
		"name": "pushPriceUpdate",
		"outputs": [],
		"stateMutability": "payable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "pyth",
		"outputs": [
			{
				"internalType": "contract IPyth",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "uint64",
				"name": "size",
				"type": "uint64"
			}
		],
		"name": "quote",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "payer",
				"type": "address"
			},
			{
				"internalType": "bytes32",
				"name": "contentHash",
				"type": "bytes32"
			}
		],
		"name": "refund",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "renounceOwnership",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "payer",
				"type": "address"
			},
			{
				"internalType": "bytes32",
				"name": "contentHash",
				"type": "bytes32"
			}
		],
		"name": "requestIdFor",
		"outputs": [
			{
				"internalType": "bytes32",
				"name": "",
				"type": "bytes32"
			}
		],
		"stateMutability": "pure",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "requestTtl",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "requestId",
				"type": "bytes32"
			}
		],
		"name": "requests",
		"outputs": [
			{
				"internalType": "uint96",
				"name": "amount",
				"type": "uint96"
			},
			{
				"internalType": "uint64",
				"name": "maxSize",
				"type": "uint64"
			},
			{
				"internalType": "uint64",
				"name": "expiry",
				"type": "uint64"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "revenue",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "maxPriceAge_",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "maxConfBps_",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "requestTtl_",
				"type": "uint256"
			}
		],
		"name": "setLimits",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "pyth_",
				"type": "address"
			},
			{
				"internalType": "bytes32",
				"name": "priceFeedId_",
				"type": "bytes32"
			}
		],
		"name": "setOracle",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bool",
				"name": "paused_",
				"type": "bool"
			}
		],
		"name": "setPaused",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "usdCentsPerMiB_",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "minChargeWei_",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "minWeiPerMiB_",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "maxWeiPerMiB_",
				"type": "uint256"
			}
		],
		"name": "setPricing",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "newOwner",
				"type": "address"
			}
		],
		"name": "transferOwnership",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "usdCentsPerMiB",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "weiPerMiB",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "to",
				"type": "address"
			}
		],
		"name": "withdrawRevenue",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	}
];

export default uploadGatewayAbi;
