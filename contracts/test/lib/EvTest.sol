// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

/// @notice The subset of Foundry/Hardhat cheatcodes these tests use.
/// @dev Declared locally rather than pulling in forge-std: the npm distribution of
///      forge-std is an unofficial flat repack that Hardhat's package-exports shim can't
///      resolve, and installing from GitHub would put a non-project-local dependency in
///      the tree. The surface we actually need is small enough to state outright.
interface Vm {
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address who, uint256 amount) external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
}

/// @notice Minimal test base: cheatcode handle plus assertions that hard-revert on failure.
abstract contract EvTest {
    /// @dev Standard cheatcode address, and the marker Hardhat/Foundry use to recognise a
    ///      contract as a test suite.
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bool public constant IS_TEST = true;

    error AssertionFailed(string what);
    error AssertionFailedUint(string what, uint256 expected, uint256 actual);

    function assertTrue(bool condition) internal pure {
        if (!condition) revert AssertionFailed("assertTrue");
    }

    function assertTrue(bool condition, string memory err) internal pure {
        if (!condition) revert AssertionFailed(err);
    }

    function assertFalse(bool condition) internal pure {
        if (condition) revert AssertionFailed("assertFalse");
    }

    function assertFalse(bool condition, string memory err) internal pure {
        if (condition) revert AssertionFailed(err);
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        if (a != b) revert AssertionFailedUint("assertEq(uint)", b, a);
    }

    function assertEq(uint256 a, uint256 b, string memory err) internal pure {
        if (a != b) revert AssertionFailedUint(err, b, a);
    }

    function assertEq(address a, address b) internal pure {
        if (a != b) revert AssertionFailed("assertEq(address)");
    }

    function assertEq(address a, address b, string memory err) internal pure {
        if (a != b) revert AssertionFailed(err);
    }

    function assertEq(bytes32 a, bytes32 b) internal pure {
        if (a != b) revert AssertionFailed("assertEq(bytes32)");
    }

    function assertEq(bytes memory a, bytes memory b) internal pure {
        if (keccak256(a) != keccak256(b)) revert AssertionFailed("assertEq(bytes)");
    }

    function assertEq(bytes memory a, bytes memory b, string memory err) internal pure {
        if (keccak256(a) != keccak256(b)) revert AssertionFailed(err);
    }
}
