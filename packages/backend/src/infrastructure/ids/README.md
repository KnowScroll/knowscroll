# infrastructure/ids

`uuidv7()`: RFC 9562 version 7 UUIDs for server-minted IDs (blueprint §5). The embedded time is
an index-locality convenience only; never use it as authority or as a causal order.
