// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface IAaveAddressesProvider {
    function getPriceOracle() external view returns (address);
}

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IAaveProtocolDataProvider {
    function getReserveConfigurationData(address asset)
        external
        view
        returns (
            uint256 decimals,
            uint256 ltv,
            uint256 liquidationThreshold,
            uint256 liquidationBonus,
            uint256 reserveFactor,
            bool usageAsCollateralEnabled,
            bool borrowingEnabled,
            bool stableBorrowRateEnabled,
            bool isActive,
            bool isFrozen
        );

    function getUserReserveData(address asset, address user)
        external
        view
        returns (
            uint256 currentATokenBalance,
            uint256 currentStableDebt,
            uint256 currentVariableDebt,
            uint256 principalStableDebt,
            uint256 scaledVariableDebt,
            uint256 stableBorrowRate,
            uint256 liquidityRate,
            uint40 stableRateLastUpdated,
            bool usageAsCollateralEnabled
        );

    function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;
}

contract AaveAtomicRescueV1 {
    struct RescueParams {
        address user;
        address asset;
        uint256 amount;
        uint256 minResultingHF;
        uint256 deadline;
    }

    error NotOwner();
    error DeadlineExpired();
    error AssetNotSupported();
    error InvalidAddress();
    error InvalidAmount();
    error ResultingHFTooLow(uint256 actual, uint256 minimum);
    error TokenTransferFailed();
    error TokenApproveFailed();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AssetSupportUpdated(address indexed asset, bool enabled);
    event RescueExecuted(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 hfBefore,
        uint256 hfAfter,
        uint256 minRequiredHF
    );

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant WAD = 1e18;

    address public owner;
    IAavePool public immutable pool;
    IAaveProtocolDataProvider public immutable dataProvider;
    IAaveOracle public immutable oracle;

    mapping(address => bool) public supportedAsset;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address pool_, address addressesProvider_, address dataProvider_) {
        if (
            owner_ == address(0) || pool_ == address(0) || addressesProvider_ == address(0)
                || dataProvider_ == address(0)
        ) {
            revert InvalidAddress();
        }

        owner = owner_;
        pool = IAavePool(pool_);
        dataProvider = IAaveProtocolDataProvider(dataProvider_);
        oracle = IAaveOracle(IAaveAddressesProvider(addressesProvider_).getPriceOracle());

        emit OwnershipTransferred(address(0), owner_);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setSupportedAsset(address asset, bool enabled) external onlyOwner {
        if (asset == address(0)) revert InvalidAddress();
        supportedAsset[asset] = enabled;
        emit AssetSupportUpdated(asset, enabled);
    }

    function rescue(RescueParams calldata params) external onlyOwner {
        if (params.deadline < block.timestamp) revert DeadlineExpired();
        if (!supportedAsset[params.asset]) revert AssetNotSupported();
        if (params.user == address(0)) revert InvalidAddress();
        if (params.amount == 0) revert InvalidAmount();

        (, , , , , uint256 hfBefore) = pool.getUserAccountData(params.user);

        _transferIn(params.asset, params.user, params.amount);
        _forceApprove(params.asset, address(pool), params.amount);

        pool.supply(params.asset, params.amount, params.user, 0);
        _ensureCollateralEnabled(params.asset, params.user);

        (, , , , , uint256 hfAfter) = pool.getUserAccountData(params.user);
        if (hfAfter < params.minResultingHF) {
            revert ResultingHFTooLow(hfAfter, params.minResultingHF);
        }

        emit RescueExecuted(
            params.user,
            params.asset,
            params.amount,
            hfBefore,
            hfAfter,
            params.minResultingHF
        );
    }

    function previewResultingHF(address user, address asset, uint256 amount)
        external
        view
        returns (uint256)
    {
        if (!supportedAsset[asset]) revert AssetNotSupported();

        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            ,
            uint256 currentLiquidationThreshold,
            ,
            uint256 currentHF
        ) = pool.getUserAccountData(user);

        if (totalDebtBase == 0) {
            return type(uint256).max;
        }

        if (amount == 0) {
            return currentHF;
        }

        (, , uint256 liquidationThreshold, , , , , , ,) =
            dataProvider.getReserveConfigurationData(asset);
        if (liquidationThreshold == 0) revert AssetNotSupported();

        uint256 assetPrice = oracle.getAssetPrice(asset);
        uint8 assetDecimals = IERC20Metadata(asset).decimals();

        uint256 addedCollateralBase = (amount * assetPrice) / (10 ** assetDecimals);

        uint256 weightedBefore =
            (totalCollateralBase * currentLiquidationThreshold) / BPS_DENOMINATOR;
        uint256 weightedAfter =
            weightedBefore + ((addedCollateralBase * liquidationThreshold) / BPS_DENOMINATOR);

        return (weightedAfter * WAD) / totalDebtBase;
    }

    function _ensureCollateralEnabled(address asset, address user) internal {
        (, , , , , , , , bool usageAsCollateralEnabled) = dataProvider.getUserReserveData(asset, user);
        if (!usageAsCollateralEnabled) {
            dataProvider.setUserUseReserveAsCollateral(asset, true);
        }
    }

    function _transferIn(address asset, address from, uint256 amount) internal {
        bool ok = IERC20(asset).transferFrom(from, address(this), amount);
        if (!ok) revert TokenTransferFailed();
    }

    function _forceApprove(address asset, address spender, uint256 amount) internal {
        uint256 current = IERC20(asset).allowance(address(this), spender);
        if (current < amount) {
            if (current != 0) {
                bool resetOk = IERC20(asset).approve(spender, 0);
                if (!resetOk) revert TokenApproveFailed();
            }
            bool ok = IERC20(asset).approve(spender, amount);
            if (!ok) revert TokenApproveFailed();
        }
    }
}
