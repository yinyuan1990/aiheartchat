// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {PriceMath} from "../libraries/PriceMath.sol";
import {BoatToken} from "./BoatToken.sol";
import {IPoolManager, IUnlockCallback, PoolKey, ModifyLiquidityParams, SwapParams, Delta} from "./IUniswapV4.sol";

/// @title BoatVault — token, Uniswap v4 pool and game reward pool in one contract
/// @notice At deployment the vault creates the token (1e9 supply, all minted here) and a BOAT/USDC v4 pool.
///         `launch()` puts POOL_TOKENS of it into a single-sided position owned by this contract; there is no
///         function that removes liquidity, so the position is locked forever. The rest is the game reward pool.
///         Rewards are paid against a cumulative total signed by the game server, with hard daily caps per
///         player and for the whole game, so a leaked server key can drain at most one day's global cap.
///         The vault also acts as the swap router for the in-site trade panel.
/// @dev Deploy through BoatLaunch so that pool initialization and liquidity happen in one transaction: an
///      initialized pool with no liquidity can be repriced for free by anyone.
contract BoatVault is IUnlockCallback, EIP712 {
    using SafeERC20 for IERC20;
    using Delta for int256;

    uint256 public constant POOL_TOKENS = 600_000_000e18; // 60% locked liquidity, 40% reward pool
    uint256 public constant START_MCAP_USDC = 5_000e6;
    uint24 public constant FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;
    uint256 public constant PLAYER_DAILY_CAP = 1_500e18;
    uint256 public constant GLOBAL_DAILY_CAP = 1_000_000e18;
    /// @dev Game days roll over at 00:00 UTC+8, same as the other Arm game.
    uint256 public constant DAY_OFFSET = 8 hours;

    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address player,uint256 total,uint256 deadline)");

    IPoolManager public immutable poolManager;
    IERC20 public immutable usdc;
    BoatToken public immutable boat;
    bool public immutable boatIsToken0;

    address public owner;
    address public signer;
    bool public launched;
    int24 public tickLower;
    int24 public tickUpper;

    /// @notice Cumulative reward paid out per player.
    mapping(address => uint256) public claimed;
    mapping(address => mapping(uint256 => uint256)) public claimedOnDay;
    mapping(uint256 => uint256) public paidOnDay;
    uint256 public totalPaid;

    uint8 private constant ACT_LAUNCH = 1;
    uint8 private constant ACT_COLLECT = 2;
    uint8 private constant ACT_SWAP = 3;

    event Launched(bytes32 indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event Deposited(address indexed player, uint256 amount);
    event Claimed(address indexed player, uint256 amount, uint256 total);
    event Swapped(address indexed trader, bool buy, uint256 amountIn, uint256 amountOut);
    event FeesCollected(uint256 boatAmount, uint256 usdcAmount);
    event Buyback(uint256 usdcIn, uint256 boatOut);
    event SignerChanged(address signer);
    event OwnerChanged(address owner);

    error NotOwner();
    error NotPoolManager();
    error AlreadyLaunched();
    error NotLaunched();
    error Expired();
    error BadSignature();
    error NothingToClaim();
    error Slippage();
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPoolManager poolManager_, IERC20 usdc_, address owner_, address signer_, string memory name_, string memory symbol_)
        EIP712("BoatVault", "1")
    {
        poolManager = poolManager_;
        usdc = usdc_;
        owner = owner_;
        signer = signer_;
        boat = new BoatToken(name_, symbol_, address(this));
        boatIsToken0 = address(boat) < address(usdc_);
    }

    // ---------------------------------------------------------------- pool

    function poolKey() public view returns (PoolKey memory) {
        (address c0, address c1) = boatIsToken0 ? (address(boat), address(usdc)) : (address(usdc), address(boat));
        return PoolKey({currency0: c0, currency1: c1, fee: FEE, tickSpacing: TICK_SPACING, hooks: address(0)});
    }

    function poolId() public view returns (bytes32) {
        return keccak256(abi.encode(poolKey()));
    }

    /// @notice One-shot: initialize the pool at the opening price and lock POOL_TOKENS as single-sided liquidity.
    function launch() external {
        if (launched) revert AlreadyLaunched();
        launched = true;
        PoolKey memory key = poolKey();
        uint160 sqrtP = PriceMath.sqrtPriceX96ForMcap(START_MCAP_USDC, boatIsToken0);
        int24 tick = poolManager.initialize(key, sqrtP);

        int24 maxTick = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        uint128 liquidity;
        if (boatIsToken0) {
            // token0-only range strictly above the price: buying BOAT pushes the price up into it
            tickLower = _floor(tick) + TICK_SPACING;
            tickUpper = maxTick;
            uint256 sa = TickMath.getSqrtRatioAtTick(tickLower);
            uint256 sb = TickMath.getSqrtRatioAtTick(tickUpper);
            liquidity = uint128(Math.mulDiv(POOL_TOKENS, Math.mulDiv(sa, sb, 1 << 96), sb - sa));
        } else {
            // token1-only range at/below the price
            tickLower = -maxTick;
            tickUpper = _floor(tick);
            uint256 sa = TickMath.getSqrtRatioAtTick(tickLower);
            uint256 sb = TickMath.getSqrtRatioAtTick(tickUpper);
            liquidity = uint128(Math.mulDiv(POOL_TOKENS, 1 << 96, sb - sa));
        }
        poolManager.unlock(abi.encode(ACT_LAUNCH, abi.encode(liquidity)));
        emit Launched(poolId(), tickLower, tickUpper, liquidity);
    }

    /// @notice Permissionless: pull accrued LP fees into the vault. BOAT fees join the reward pool, USDC fees
    ///         wait here for `buyback`.
    function collectFees() external returns (uint256 boatAmount, uint256 usdcAmount) {
        if (!launched) revert NotLaunched();
        (boatAmount, usdcAmount) = abi.decode(poolManager.unlock(abi.encode(ACT_COLLECT, "")), (uint256, uint256));
        emit FeesCollected(boatAmount, usdcAmount);
    }

    /// @notice Owner (keeper) turns collected USDC into BOAT for the reward pool. `minOut` guards against
    ///         sandwiching, so this is not permissionless.
    function buyback(uint256 usdcIn, uint256 minOut) external onlyOwner returns (uint256 out) {
        out = _swap(true, usdcIn, minOut, address(this), address(this));
        emit Buyback(usdcIn, out);
    }

    // ---------------------------------------------------------------- trading (in-site trade panel)

    /// @notice Buy BOAT with exact USDC. Caller approves USDC to this vault.
    function buy(uint256 usdcIn, uint256 minBoatOut, address to) external returns (uint256 out) {
        out = _swap(true, usdcIn, minBoatOut, msg.sender, to);
        emit Swapped(msg.sender, true, usdcIn, out);
    }

    /// @notice Sell exact BOAT for USDC. Caller approves BOAT to this vault.
    function sell(uint256 boatIn, uint256 minUsdcOut, address to) external returns (uint256 out) {
        out = _swap(false, boatIn, minUsdcOut, msg.sender, to);
        emit Swapped(msg.sender, false, boatIn, out);
    }

    function _swap(bool buyBoat, uint256 amountIn, uint256 minOut, address payer, address to) internal returns (uint256) {
        if (!launched) revert NotLaunched();
        if (amountIn == 0 || amountIn > uint256(type(int256).max)) revert ZeroAmount();
        bytes memory r = poolManager.unlock(abi.encode(ACT_SWAP, abi.encode(buyBoat, amountIn, minOut, payer, to)));
        return abi.decode(r, (uint256));
    }

    // ---------------------------------------------------------------- game

    /// @notice Move BOAT into the game balance (credited off-chain from this event). Deposits join the reward pool.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        IERC20(address(boat)).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw winnings. `total` is the player's cumulative withdrawable amount signed by the game
    ///         server; this pays the unpaid part, limited by today's player / global caps and the pool balance.
    ///         Whatever is left can be claimed later with the same or a newer signature.
    function claim(uint256 total, uint256 deadline, bytes calldata sig) external returns (uint256 paid) {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, total, deadline)));
        if (ECDSA.recover(digest, sig) != signer) revert BadSignature();
        uint256 done = claimed[msg.sender];
        if (total <= done) revert NothingToClaim();
        uint256 day = today();
        paid = Math.min(total - done, PLAYER_DAILY_CAP - claimedOnDay[msg.sender][day]);
        paid = Math.min(paid, GLOBAL_DAILY_CAP - paidOnDay[day]);
        paid = Math.min(paid, boat.balanceOf(address(this)));
        if (paid == 0) revert NothingToClaim();
        claimed[msg.sender] = done + paid;
        claimedOnDay[msg.sender][day] += paid;
        paidOnDay[day] += paid;
        totalPaid += paid;
        IERC20(address(boat)).safeTransfer(msg.sender, paid);
        emit Claimed(msg.sender, paid, total);
    }

    function today() public view returns (uint256) {
        return (block.timestamp + DAY_OFFSET) / 1 days;
    }

    /// @notice Reward pool = all BOAT held here (the locked LP lives in the PoolManager).
    function rewardPool() external view returns (uint256) {
        return boat.balanceOf(address(this));
    }

    // ---------------------------------------------------------------- admin (no access to funds)

    function setSigner(address s) external onlyOwner {
        signer = s;
        emit SignerChanged(s);
    }

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerChanged(o);
    }

    // ---------------------------------------------------------------- v4 callback

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 act, bytes memory p) = abi.decode(data, (uint8, bytes));
        PoolKey memory key = poolKey();

        if (act == ACT_LAUNCH) {
            uint128 liquidity = abi.decode(p, (uint128));
            (int256 d,) = poolManager.modifyLiquidity(
                key, ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(liquidity)), bytes32(0)), ""
            );
            _settleDelta(key, d, address(this));
            return "";
        }

        if (act == ACT_COLLECT) {
            (int256 d,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(tickLower, tickUpper, 0, bytes32(0)), "");
            uint256 a0 = d.amount0() > 0 ? uint256(uint128(d.amount0())) : 0;
            uint256 a1 = d.amount1() > 0 ? uint256(uint128(d.amount1())) : 0;
            if (a0 > 0) poolManager.take(key.currency0, address(this), a0);
            if (a1 > 0) poolManager.take(key.currency1, address(this), a1);
            return boatIsToken0 ? abi.encode(a0, a1) : abi.encode(a1, a0);
        }

        // ACT_SWAP
        (bool buyBoat, uint256 amountIn, uint256 minOut, address payer, address to) =
            abi.decode(p, (bool, uint256, uint256, address, address));
        // input currency is currency0 when we sell token0 for token1
        bool zeroForOne = buyBoat ? !boatIsToken0 : boatIsToken0;
        int256 sd = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            }),
            ""
        );
        (int128 dIn, int128 dOut) = zeroForOne ? (sd.amount0(), sd.amount1()) : (sd.amount1(), sd.amount0());
        uint256 out = uint256(uint128(dOut));
        if (out < minOut) revert Slippage();
        _pay(zeroForOne ? key.currency0 : key.currency1, payer, uint256(uint128(-dIn)));
        poolManager.take(zeroForOne ? key.currency1 : key.currency0, to, out);
        return abi.encode(out);
    }

    function _settleDelta(PoolKey memory key, int256 d, address payer) internal {
        if (d.amount0() < 0) _pay(key.currency0, payer, uint256(uint128(-d.amount0())));
        if (d.amount1() < 0) _pay(key.currency1, payer, uint256(uint128(-d.amount1())));
    }

    function _pay(address currency, address payer, uint256 amount) internal {
        if (amount == 0) return;
        poolManager.sync(currency);
        if (payer == address(this)) IERC20(currency).safeTransfer(address(poolManager), amount);
        else IERC20(currency).safeTransferFrom(payer, address(poolManager), amount);
        poolManager.settle();
    }

    function _floor(int24 tick) internal pure returns (int24) {
        int24 c = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) c--;
        return c * TICK_SPACING;
    }
}

/// @notice Deploys the vault and launches the pool in the same transaction (see BoatVault @dev).
contract BoatLaunch {
    BoatVault public immutable vault;

    constructor(IPoolManager poolManager, IERC20 usdc, address owner, address signer, string memory name, string memory symbol) {
        vault = new BoatVault(poolManager, usdc, owner, signer, name, symbol);
        vault.launch();
    }
}
