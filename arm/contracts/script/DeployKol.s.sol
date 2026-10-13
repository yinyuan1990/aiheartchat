// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {FeeLocker} from "../src/FeeLocker.sol";
import {ReferralHub} from "../src/ReferralHub.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";

/// 10.13 KOL-mode generation: a new LaunchFactory (adds `kol` to LaunchParams) with its own FeeLocker / ReferralHub
/// (their factory is wired once, so a new factory needs new ones). Uniswap V3, our SwapRouter / QuoterV2 and the
/// Treasury are reused from deployments/arc-mainnet.json.
///   forge script script/DeployKol.s.sol --rpc-url https://rpc.mainnet.arc.io --private-key $DK --broadcast
contract DeployKol is Script {
    function run() external {
        string memory cur = vm.readFile("deployments/arc-mainnet.json");
        address uni = vm.parseJsonAddress(cur, ".uniswapV3Factory");
        address nfpm = vm.parseJsonAddress(cur, ".positionManager");
        address router = vm.parseJsonAddress(cur, ".swapRouter");
        address usdc = vm.parseJsonAddress(cur, ".usdc");
        address treasury = vm.parseJsonAddress(cur, ".treasury");
        address keeper = vm.parseJsonAddress(cur, ".keeper");
        address owner = vm.parseJsonAddress(cur, ".owner");
        require(msg.sender == owner, "run as the owner: setFactory is one-time and owner-only");

        vm.startBroadcast();
        FeeLocker locker = new FeeLocker(nfpm, router, treasury, owner);
        ReferralHub hub = new ReferralHub(usdc, address(locker), keeper, owner);
        LaunchFactory factory =
            new LaunchFactory(uni, nfpm, router, usdc, address(locker), treasury, address(hub), owner);
        locker.setFactory(address(factory));
        hub.setFactory(address(factory));
        vm.stopBroadcast();

        string memory j = "kol";
        vm.serializeUint(j, "deployBlock", block.number);
        vm.serializeAddress(j, "feeLocker", address(locker));
        vm.serializeAddress(j, "referralHub", address(hub));
        string memory out = vm.serializeAddress(j, "launchFactory", address(factory));
        vm.writeJson(out, vm.envOr("OUT_FILE", string("deployments/kol-mainnet.json")));

        console2.log("FeeLocker    ", address(locker));
        console2.log("ReferralHub  ", address(hub));
        console2.log("LaunchFactory", address(factory));
    }
}
