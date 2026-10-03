// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain fixed-supply ERC20 for the speedboat game. The whole supply is minted once to the BoatVault;
///         there is no owner, no further mint, no tax, no blacklist.
contract BoatToken is ERC20 {
    uint256 public constant SUPPLY = 1_000_000_000e18;

    constructor(string memory name_, string memory symbol_, address vault) ERC20(name_, symbol_) {
        _mint(vault, SUPPLY);
    }
}
