# Apps Script stable song IDs

The stable song ID migration stores IDs only in the hidden `Song Index` sheet:

- setlist column A remains the song/proof-link column;
- setlist column B remains the FC player column;
- no third column is added to, hidden on, or written in any setlist tab;
- `Song Index` column I stores the immutable song ID.

After copying `Config.gs`, `Helpers.gs`, `SongIndex.gs`, and `DiscordAPI.gs`
into the Apps Script project and deploying a new web-app version, run
`fcBotMigrateStableSongIds()` once.

Confirm that `/botstatus` reports API version `1.4.1`. If it reports an older
version, the web-app deployment is still serving an earlier combination of
the files even if the editor contains the new source.

The migration performs a full index rebuild. It preserves an existing ID when
a song name is unique within its setlist, even if its row moved. New, renamed,
or ambiguously duplicated songs receive new IDs so an old autocomplete choice
cannot silently target a different row.
