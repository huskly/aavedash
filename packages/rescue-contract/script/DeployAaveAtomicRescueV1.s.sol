// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Script} from "forge-std/Script.sol";
import {AaveAtomicRescueV1} from "../src/AaveAtomicRescueV1.sol";

contract DeployAaveAtomicRescueV1 is Script {
    function run() external {
        address owner = vm.envAddress("RESCUE_OWNER");
        address pool = vm.envAddress("AAVE_POOL");
        address addressesProvider = vm.envAddress("AAVE_ADDRESSES_PROVIDER");
        address dataProvider = vm.envAddress("AAVE_PROTOCOL_DATA_PROVIDER");
        address wbtc = vm.envAddress("WBTC_ADDRESS");

        vm.startBroadcast();

        AaveAtomicRescueV1 rescue =
            new AaveAtomicRescueV1(owner, pool, addressesProvider, dataProvider);
        rescue.setSupportedAsset(wbtc, true);

        vm.stopBroadcast();
    }
}
