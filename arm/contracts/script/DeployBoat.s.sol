// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BoatLaunch, BoatVault} from "../src/game/BoatVault.sol";
import {IPoolManager} from "../src/game/IUniswapV4.sol";

/// Deploys $BOAT + BoatVault and launches the v4 pool in one transaction.
///   BOAT_SIGNER=<game server signer address> forge script script/DeployBoat.s.sol \
///     --rpc-url https://rpc.mainnet.arc.io --private-key $DEPLOYER_KEY --broadcast
/// The deployer becomes the vault owner (setSigner / buyback only; it can't move the reward pool or the LP).
contract DeployBoat is Script {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IERC20 constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    function run() external {
        address signer = vm.envAddress("BOAT_SIGNER");
        vm.startBroadcast();
        BoatLaunch l = new BoatLaunch(PM, USDC, msg.sender, signer, "Speedboat", "BOAT");
        vm.stopBroadcast();
        BoatVault v = l.vault();
        console2.log("vault", address(v));
        console2.log("boat", address(v.boat()));
        console2.log("boatIsToken0", v.boatIsToken0());
        console2.log("rewardPool", v.rewardPool() / 1e18);
        console2.logBytes32(v.poolId());
    }
}
