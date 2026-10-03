// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BoatVault, BoatLaunch} from "../../src/game/BoatVault.sol";
import {IPoolManager, PoolKey} from "../../src/game/IUniswapV4.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

interface IStateView {
    function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

interface IV4Quoter {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams memory params) external returns (uint256 amountOut, uint256 gasEstimate);
}

/// Runs against the real Uniswap v4 deployment on Arc mainnet:
///   ARC_RPC_URL=https://rpc.mainnet.arc.io forge test --match-path test/game/BoatVault.fork.t.sol -vv
/// Native USDC moves balances through an Arc precompile (0x1800…) that the Foundry EVM doesn't implement, so the
/// USDC address is overwritten with a 6-decimal ERC20 on the fork. The PoolManager, quoter and state view are real.
abstract contract BoatVaultForkBase is Test {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IStateView constant STATE = IStateView(0xF3334192D15450CdD385c8B70e03f9A6bD9E673b);
    IV4Quoter constant QUOTER = IV4Quoter(0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94);
    IERC20 USDC;

    /// where the USDC stand-in lives: decides whether BOAT sorts as token0 or token1
    function usdcAddr() internal pure virtual returns (address);

    BoatVault vault;
    IERC20 boat;
    address owner = makeAddr("owner");
    uint256 signerKey = 0xB0A7;
    address signer;
    address trader = makeAddr("trader");
    address player = makeAddr("player");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ARC_RPC_URL", string("https://rpc.mainnet.arc.io")));
        address u = usdcAddr();
        vm.etch(u, address(new MockUSDC()).code);
        for (uint256 i = 0; i < 6; i++) vm.store(u, bytes32(i), bytes32(0));
        USDC = IERC20(u);
        signer = vm.addr(signerKey);
        BoatLaunch l = new BoatLaunch(PM, USDC, owner, signer, "Speedboat", "BOAT");
        vault = l.vault();
        boat = IERC20(address(vault.boat()));
        _fundUsdc(trader, 500e6);
    }

    function _fundUsdc(address to, uint256 amount) internal {
        MockUSDC(address(USDC)).mint(to, amount);
    }

    function test_launch_state() public {
        assertTrue(vault.launched());
        // 60% sits in the PoolManager as liquidity (minus rounding), 40% stays as the reward pool
        uint256 pool = vault.rewardPool();
        assertGe(pool, 400_000_000e18);
        assertLt(pool, 400_000_001e18);
        assertEq(boat.balanceOf(address(vault)) + boat.balanceOf(address(PM)) >= 999_999_999e18, true);
        (uint160 sqrtP,,, uint24 lpFee) = STATE.getSlot0(vault.poolId());
        assertGt(sqrtP, 0);
        assertEq(lpFee, 10_000);
        // position out of range at the start → active liquidity 0 until the first buy
        emit log_named_uint("liquidity", STATE.getLiquidity(vault.poolId()));
    }

    function test_buy_sell_roundtrip_and_fees() public {
        vm.startPrank(trader);
        USDC.approve(address(vault), type(uint256).max);
        boat.approve(address(vault), type(uint256).max);

        PoolKey memory key = vault.poolKey();
        bool buyZeroForOne = !vault.boatIsToken0();
        (uint256 quoted,) = QUOTER.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, buyZeroForOne, 100e6, ""));
        uint256 got = vault.buy(100e6, quoted * 99 / 100, trader);
        assertEq(got, quoted);
        assertEq(boat.balanceOf(trader), got);
        // 100 USDC at ~5k mcap buys a big slice; sanity: between 1% and 5% of supply
        assertGt(got, 10_000_000e18);
        assertLt(got, 50_000_000e18);
        emit log_named_decimal_uint("BOAT for 100 USDC", got, 18);

        uint256 usdcBefore = USDC.balanceOf(trader);
        uint256 back = vault.sell(got / 2, 0, trader);
        assertEq(USDC.balanceOf(trader) - usdcBefore, back);
        assertGt(back, 40e6);
        vm.stopPrank();

        // slippage guard
        vm.prank(trader);
        vm.expectRevert(BoatVault.Slippage.selector);
        vault.buy(1e6, type(uint256).max, trader);

        // 1% fees on both legs accrue to the vault's position
        uint256 poolBefore = vault.rewardPool();
        (uint256 fb, uint256 fu) = vault.collectFees();
        assertGt(fb, 0);
        assertGt(fu, 0);
        assertApproxEqAbs(fu, 1e6, 0.02e6); // 1% of 100 USDC
        assertEq(vault.rewardPool(), poolBefore + fb);

        // buyback is owner-only and adds to the reward pool
        vm.expectRevert(BoatVault.NotOwner.selector);
        vault.buyback(fu, 0);
        vm.prank(owner);
        uint256 bought = vault.buyback(fu, 0);
        assertGt(bought, 0);
        assertEq(vault.rewardPool(), poolBefore + fb + bought);
        assertEq(USDC.balanceOf(address(vault)), 0);
    }

    function test_no_way_to_relaunch() public {
        vm.expectRevert(BoatVault.AlreadyLaunched.selector);
        vault.launch();
    }

    function _sig(address p, uint256 total, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(vault.CLAIM_TYPEHASH(), p, total, deadline));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BoatVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_claim_caps_and_replay() public {
        uint256 dl = block.timestamp + 1 hours;
        // 2000 earned: only 1500 today
        bytes memory sig1 = _sig(player, 2_000e18, dl);
        vm.prank(player);
        uint256 paid = vault.claim(2_000e18, dl, sig1);
        assertEq(paid, 1_500e18);
        assertEq(boat.balanceOf(player), 1_500e18);

        // same signature again today → capped out
        bytes memory sig2 = _sig(player, 2_000e18, dl);
        vm.prank(player);
        vm.expectRevert(BoatVault.NothingToClaim.selector);
        vault.claim(2_000e18, dl, sig2);

        // next day the remaining 500 comes through with the same total
        vm.warp(block.timestamp + 1 days);
        uint256 dl2 = block.timestamp + 1 hours;
        bytes memory sig3 = _sig(player, 2_000e18, dl2);
        vm.prank(player);
        assertEq(vault.claim(2_000e18, dl2, sig3), 500e18);
        assertEq(vault.claimed(player), 2_000e18);

        // signature for another player / wrong signer / expired
        bytes memory sig4 = _sig(player, 3_000e18, dl2);
        vm.prank(trader);
        vm.expectRevert(BoatVault.BadSignature.selector);
        vault.claim(3_000e18, dl2, sig4);
        vm.warp(dl2 + 1);
        bytes memory sig5 = _sig(player, 3_000e18, dl2);
        vm.prank(player);
        vm.expectRevert(BoatVault.Expired.selector);
        vault.claim(3_000e18, dl2, sig5);
    }

    function test_global_daily_cap() public {
        uint256 dl = block.timestamp + 1 hours;
        uint256 total;
        // 667 players × 1500 > 1,000,000 → the last one gets only the remainder
        for (uint256 i = 0; i < 667; i++) {
            address p = address(uint160(0x10000 + i));
            bytes memory sig6 = _sig(p, 1_500e18, dl);
            vm.prank(p);
            total += vault.claim(1_500e18, dl, sig6);
        }
        assertEq(total, 1_000_000e18);
        address late = address(uint160(0x90000));
        bytes memory sig7 = _sig(late, 10e18, dl);
        vm.prank(late);
        vm.expectRevert(BoatVault.NothingToClaim.selector);
        vault.claim(10e18, dl, sig7);
    }

    function test_deposit_joins_pool_and_admin_cannot_take_funds() public {
        bytes memory sig8 = _sig(player, 100e18, block.timestamp + 1);
        vm.prank(player);
        vault.claim(100e18, block.timestamp + 1, sig8);
        uint256 before = vault.rewardPool();
        vm.startPrank(player);
        boat.approve(address(vault), 100e18);
        vault.deposit(100e18);
        vm.stopPrank();
        assertEq(vault.rewardPool(), before + 100e18);

        vm.expectRevert(BoatVault.NotOwner.selector);
        vault.setSigner(address(1));
        vm.prank(owner);
        vault.setSigner(address(1));
        assertEq(vault.signer(), address(1));
    }
}

/// Mainnet layout: USDC at 0x3600… sorts below almost every token, so BOAT is currency1.
contract BoatVaultForkUsdcLow is BoatVaultForkBase {
    function usdcAddr() internal pure override returns (address) {
        return 0x3600000000000000000000000000000000000000;
    }
}

/// The other branch: BOAT sorts as currency0 (happens on mainnet if the vault deploys BOAT below 0x36…).
contract BoatVaultForkUsdcHigh is BoatVaultForkBase {
    function usdcAddr() internal pure override returns (address) {
        return 0xffffffff00000000000000000000000000005042;
    }
}
