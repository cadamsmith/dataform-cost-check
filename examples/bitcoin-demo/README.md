# Bitcoin demo

A local run of the check on a two-commit Dataform project. It reads the public view
`bigquery-public-data.crypto_bitcoin.transactions`, and the second commit deletes the
`WHERE` line that limits the scan to one month.

```sh
pnpm build
examples/bitcoin-demo/run.sh                    # about +$143 / month, over the $100 limit: fails
examples/bitcoin-demo/run.sh --limit 500        # same estimate, within the limit: passes
examples/bitcoin-demo/run.sh --project missing  # every dry run fails: the check fails and says why
examples/bitcoin-demo/run.sh --pr 16            # also posts the sticky comment on PR #16; rerun edits it
```

`--pr` posts to a pull request in the repository this script lives in, with your `gh`
login. Run it more than once to see the same comment edited in place.

Needs the Dataform CLI (`npm install -g @dataform/cli`) and Application Default
Credentials (`gcloud auth application-default login`). Dry runs are free; the script uses
your current `gcloud` project unless you pass `--project`. It builds the demo project in
a temporary directory each time, so it leaves nothing behind in this repository.
