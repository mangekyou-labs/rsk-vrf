# Coordinator upgrade checks

Run the same gates as CI from the repository root:

```sh
python3 contracts/script/test-upgrade-safety.py --integration
python3 contracts/script/check-upgrade-safety.py
```

The gate compiles the coordinator and checks its deployed runtime against the 24,576-byte limit. A margin below 1,024 bytes emits a GitHub Actions warning. Creation bytecode is not used for this check.

The committed snapshot is `contracts/storage-layout/VRFCoordinator.json`. ERC-7201 structs do not appear in the coordinator's ordinary Solidity storage layout. The extractor instead discovers namespaced structs in its inheritance tree and compiles a temporary contract containing those structs. Solidity supplies member slots, offsets, widths, and nested mapping/array layouts. The snapshot also records enum variants and the actual namespace locations used by storage accessors, including inherited OpenZeppelin storage. Unsupported accessor expressions fail the gate for explicit review.

Existing namespaces and fields must retain their locations, order, types and enum variant order. Appending fields to a namespace or a mapping value is allowed; changing the element size of an array is rejected. New namespaces are allowed. Ordinary, non-namespaced coordinator storage is rejected. These checks protect layout compatibility; upgrade authorization and retained request behavior are tested separately through the proxy.

After an intentional compatible addition, regenerate and review the snapshot:

```sh
python3 contracts/script/check-upgrade-safety.py --write-snapshot
```

Regeneration first checks compatibility with the existing snapshot. CI also compares the compiled layout with the base revision's snapshot, so committing an incompatible regenerated snapshot cannot bypass the gate. The initial adoption PR bootstraps this check because its base predates the snapshot. Subsequent PRs remain checked against the existing base snapshot, including when a PR deletes or replaces its own snapshot.

The integration gate tests compile source mutations that change the coordinator's namespace location, mapped Request packing, and drand array element packing. Each must fail against the committed snapshot. They restore the source after each run.
