// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {AaveAtomicRescueV1} from "../src/AaveAtomicRescueV1.sol";

contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 8;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockPool {
    struct AccountData {
        uint256 totalCollateralBase;
        uint256 totalDebtBase;
        uint256 availableBorrowsBase;
        uint256 currentLiquidationThreshold;
        uint256 ltv;
        uint256 healthFactor;
    }

    mapping(address => AccountData) public accountData;

    function setUserAccountData(address user, AccountData memory data) external {
        accountData[user] = data;
    }

    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        AccountData memory data = accountData[user];
        return (
            data.totalCollateralBase,
            data.totalDebtBase,
            data.availableBorrowsBase,
            data.currentLiquidationThreshold,
            data.ltv,
            data.healthFactor
        );
    }

    function supply(address, uint256 amount, address onBehalfOf, uint16) external {
        AccountData storage data = accountData[onBehalfOf];
        data.totalCollateralBase += amount / 100; // test-only simplified conversion
        data.healthFactor += 0.2e18;
    }

}

contract MockAddressesProvider {
    address public oracle;

    constructor(address oracle_) {
        oracle = oracle_;
    }

    function getPriceOracle() external view returns (address) {
        return oracle;
    }
}

contract MockOracle {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }

    function getAssetPrice(address) external view returns (uint256) {
        return price;
    }
}

contract MockDataProvider {
    uint256 public liquidationThreshold = 7_500;

    function getReserveConfigurationData(address)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, bool, bool, bool, bool, bool)
    {
        return (8, 7_000, liquidationThreshold, 0, 0, true, true, false, true, false);
    }
}

contract AaveAtomicRescueV1Test is Test {
    address internal owner = makeAddr("owner");
    address internal user = makeAddr("user");

    MockToken internal token;
    MockPool internal pool;
    MockOracle internal oracle;
    MockDataProvider internal dataProvider;
    MockAddressesProvider internal addressesProvider;
    AaveAtomicRescueV1 internal rescue;

    function setUp() external {
        token = new MockToken();
        pool = new MockPool();
        oracle = new MockOracle(100_000_000); // 1.0 in base
        dataProvider = new MockDataProvider();
        addressesProvider = new MockAddressesProvider(address(oracle));

        rescue =
            new AaveAtomicRescueV1(owner, address(pool), address(addressesProvider), address(dataProvider));

        vm.prank(owner);
        rescue.setSupportedAsset(address(token), true);

        token.mint(user, 1_000_000_000);
        vm.prank(user);
        token.approve(address(rescue), type(uint256).max);

        pool.setUserAccountData(
            user,
            MockPool.AccountData({
                totalCollateralBase: 1_000_000,
                totalDebtBase: 1_000_000,
                availableBorrowsBase: 0,
                currentLiquidationThreshold: 7_500,
                ltv: 7_000,
                healthFactor: 1.2e18
            })
        );
    }

    function test_owner_only() external {
        AaveAtomicRescueV1.RescueParams memory params = AaveAtomicRescueV1.RescueParams({
            user: user,
            asset: address(token),
            amount: 10_000_000,
            minResultingHF: 1.1e18,
            deadline: block.timestamp + 1
        });

        vm.prank(user);
        vm.expectRevert(AaveAtomicRescueV1.NotOwner.selector);
        rescue.rescue(params);
    }

    function test_reverts_if_deadline_expired() external {
        AaveAtomicRescueV1.RescueParams memory params = AaveAtomicRescueV1.RescueParams({
            user: user,
            asset: address(token),
            amount: 10_000_000,
            minResultingHF: 1.1e18,
            deadline: block.timestamp - 1
        });

        vm.prank(owner);
        vm.expectRevert(AaveAtomicRescueV1.DeadlineExpired.selector);
        rescue.rescue(params);
    }

    function test_executes_rescue_when_result_hf_is_sufficient() external {
        AaveAtomicRescueV1.RescueParams memory params = AaveAtomicRescueV1.RescueParams({
            user: user,
            asset: address(token),
            amount: 10_000_000,
            minResultingHF: 1.3e18,
            deadline: block.timestamp + 10
        });

        vm.prank(owner);
        rescue.rescue(params);

        (, , , , , uint256 hfAfter) = pool.getUserAccountData(user);
        assertGe(hfAfter, 1.3e18);
    }

    function test_reverts_if_resulting_hf_too_low() external {
        // Mock pool only adds 0.2e18 per supply call, so starting HF 1.2e18 → 1.4e18.
        // Requiring 2.0e18 should revert.
        AaveAtomicRescueV1.RescueParams memory params = AaveAtomicRescueV1.RescueParams({
            user: user,
            asset: address(token),
            amount: 10_000_000,
            minResultingHF: 2.0e18,
            deadline: block.timestamp + 10
        });

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AaveAtomicRescueV1.ResultingHFTooLow.selector, 1.4e18, 2.0e18)
        );
        rescue.rescue(params);
    }

    function test_reverts_if_asset_not_supported() external {
        MockToken unsupported = new MockToken();
        unsupported.mint(user, 1_000_000_000);
        vm.prank(user);
        unsupported.approve(address(rescue), type(uint256).max);

        AaveAtomicRescueV1.RescueParams memory params = AaveAtomicRescueV1.RescueParams({
            user: user,
            asset: address(unsupported),
            amount: 10_000_000,
            minResultingHF: 1.1e18,
            deadline: block.timestamp + 10
        });

        vm.prank(owner);
        vm.expectRevert(AaveAtomicRescueV1.AssetNotSupported.selector);
        rescue.rescue(params);
    }

    function test_preview_increases_with_amount() external {
        uint256 hf0 = rescue.previewResultingHF(user, address(token), 0);
        uint256 hf1 = rescue.previewResultingHF(user, address(token), 10_000_000);
        assertGt(hf1, hf0);
    }
}
