// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title MerkleDrop
/// @notice Merkle-based airdrop distributor for CLARA tokens.
/// @dev Immutable — root set in constructor, 6-month claim deadline, bitmap for double-claim protection.
contract MerkleDrop {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint256 public immutable deadline;
    address public immutable treasury;

    // Bitmap for double-claim protection (index -> bit)
    mapping(uint256 => uint256) private claimedBitMap;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    constructor(
        address _token,
        bytes32 _merkleRoot,
        uint256 _claimDuration,
        address _treasury
    ) {
        require(_token != address(0), "Zero token");
        require(_merkleRoot != bytes32(0), "Zero root");
        require(_claimDuration > 0, "Zero duration");
        require(_treasury != address(0), "Zero treasury");

        token = IERC20(_token);
        merkleRoot = _merkleRoot;
        deadline = block.timestamp + _claimDuration;
        treasury = _treasury;
    }

    function isClaimed(uint256 index) public view returns (bool) {
        uint256 claimedWordIndex = index / 256;
        uint256 claimedBitIndex = index % 256;
        uint256 claimedWord = claimedBitMap[claimedWordIndex];
        uint256 mask = (1 << claimedBitIndex);
        return claimedWord & mask == mask;
    }

    function _setClaimed(uint256 index) private {
        uint256 claimedWordIndex = index / 256;
        uint256 claimedBitIndex = index % 256;
        claimedBitMap[claimedWordIndex] = claimedBitMap[claimedWordIndex] | (1 << claimedBitIndex);
    }

    function claim(
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external {
        require(block.timestamp <= deadline, "Claim period ended");
        require(!isClaimed(index), "Already claimed");

        bytes32 node = keccak256(abi.encodePacked(index, account, amount));
        require(MerkleProof.verify(merkleProof, merkleRoot, node), "Invalid proof");

        _setClaimed(index);
        token.safeTransfer(account, amount);

        emit Claimed(index, account, amount);
    }

    /// @notice Sweep unclaimed tokens back to treasury after deadline
    function sweep() external {
        require(block.timestamp > deadline, "Claim period not ended");
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "Nothing to sweep");
        token.safeTransfer(treasury, balance);
        emit Swept(treasury, balance);
    }
}
