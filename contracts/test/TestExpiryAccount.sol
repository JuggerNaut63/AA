// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.12;

import "../samples/SimpleAccount.sol";

/**
 * A test account, for testing expiry.
 * add "temporary" owners, each with a time range (since..till) times for each.
 * NOTE: this is not a full "session key" implementation: a real session key should probably limit
 * other things, like target contracts and methods to be called.
 * also, the "since" value is not really useful, only for testing the entrypoint.
 */
contract TestExpiryAccount is SimpleAccount {
    using ECDSA for bytes32;

    struct TokenApproval {
	bool enable;
	uint256 amount;
    }

    struct PermissionParam {
        address whitelistDestination;
        bytes4[] whitelistMethods;
        uint256 tokenAmount;
    }
    
    struct PermissionStorage {
	address[] whitelistDestinations;
	mapping(address => bool) whitelistDestinationMap;
	mapping(address => bytes4[]) whitelistMethods;
	mapping(address => mapping(bytes4 => bool)) whitelistMethodsMap;
	mapping(address => TokenApproval) tokenApprovals; // TokenApproval[] 로 변경?
    }

    mapping(address => PermissionStorage) internal permissionMap;

    mapping(address => uint48) public ownerAfter;
    mapping(address => uint48) public ownerUntil;

    // solhint-disable-next-line no-empty-blocks
    constructor(IEntryPoint anEntryPoint) SimpleAccount(anEntryPoint) {}


    function initialize(address anOwner) public virtual override initializer {
        super._initialize(anOwner);
        addTemporaryOwner(anOwner, 0, type(uint48).max);
    }

    // As this is a test contract, no need for proxy, so no need to disable init
    // solhint-disable-next-line no-empty-blocks
    function _disableInitializers() internal override {}

    function addTemporaryOwner(address owner, uint48 _after, uint48 _until, PermissionParam[] calldata permissions) public onlyOwner {
        require(_until > _after, "wrong until/after");
        ownerAfter[owner] = _after;
        ownerUntil[owner] = _until;
	
	PermissionStorage storage _permissionStorage = permissionMap[owner];
	address[] memory whitelistAddresses = new address[] (permissions.length);
	
	for (uint256 index = 0; index < permissions.length; index++) {
	    PermissionParam memory permission = permissions[index];
	    address whitelistedDestination = permission.whitelistDestination;
	    whitelistAddresses[index] = whitelistedDestination;

	    _permissionStorage.whitelistDestinationMap[whitelistedDestination] = true;
	    _permissionStorage.whitelistMethods[whitelistedDestination] = permission.whitelistedMethods;

	    for (uint256 methodIndex = 0; methodIndex < permission.whitelistMethods.length; methodIndex++) {
		_permissionStorage.whitelistMethodsMap[whitelistedDestination] [
		        permission.whitelistMethods[methodIndex]
		    ] = true;
	    }

	    if (permission.tokenAmount > 0) {
		_permissionStorage.tokenApprovals[whitelistedDestination] = TokenApproval({enable: true, amount: permission.tokenAmount});
	    }
	}
	_permissionStorage.whitelistDestinations = whitelistAddresses;
    }

    /// implement template method of BaseAccount
    function _validateSignature(UserOperation calldata userOp, bytes32 userOpHash)
    internal override view returns (uint256 validationData) {
        bytes32 hash = userOpHash.toEthSignedMessageHash();
        address signer = hash.recover(userOp.signature);
        uint48 _until = ownerUntil[signer];
        uint48 _after = ownerAfter[signer];

        //we have "until" value for all valid owners. so zero means "invalid signature"
        bool sigFailed = _until == 0;
        return _packValidationData(sigFailed, _until, _after);
    }
}
