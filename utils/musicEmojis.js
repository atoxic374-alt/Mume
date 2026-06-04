'use strict';

const MUSIC_EMOJIS = {
    loop:        { id: '1511836496053796879', name: 'loop' },
    volumeUp:    { id: '1511836494057312359', name: 'volumeUp' },
    pause:       { id: '1511836485815632065', name: 'pause' },
    volumeDown:  { id: '1511836491721085034', name: 'volumeDown' },
    skip:        { id: '1511836482170519604', name: 'skip' },
    stop:        { id: '1511836488797782037', name: 'stop' },
    like:        { id: '1511836479570313338', name: 'like' },
    dislike:     { id: '1511836476869181641', name: 'dislike' },
    queue:       { id: '1511836499392466974', name: 'queue' },
    settings:    { id: '1511856454838255616', name: 'settings' },
    filters:     { id: '1511837180530790592', name: 'filters' },
    artistTop:   { id: '1511836503096164595', name: 'artistTop' },
    smartSearch: { id: '1511837177800298669', name: 'smartSearch' },
    pageNext:    { id: '1251766110022537256', name: 'pageNext' },
    pagePrev:    { id: '1251766205111468043', name: 'pagePrev' },
    clear:       { id: '1240135421434925076', name: 'clear' },
    platforms: {
        ytsearch:  { id: '1511837171772821544', name: 'youtube' },
        ytmsearch: '🎵',
        scsearch:  { id: '1511837168824356925', name: 'soundcloud' },
        spsearch:  { id: '1511837174323085443', name: 'spotify' },
        amsearch:  { id: '1511837166014169228', name: 'applemusic' },
        dzsearch:  { id: '1511837155247259768', name: 'deezer' },
    },
};

function emojiStr(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    if (data.id && data.name) return `<:${data.name}:${data.id}>`;
    return '';
}

module.exports = MUSIC_EMOJIS;
module.exports.emojiStr = emojiStr;
