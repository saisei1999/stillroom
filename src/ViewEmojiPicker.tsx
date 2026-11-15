import EmojiPicker, { EmojiStyle } from 'emoji-picker-react';
export default function ViewEmojiPicker({onSelect}:{onSelect:(emoji:string)=>void}) {
 return <EmojiPicker onEmojiClick={item=>onSelect(item.emoji)} emojiStyle={EmojiStyle.NATIVE} autoFocusSearch searchPlaceholder="Search emoji" width="100%" height={300} previewConfig={{showPreview:false}} lazyLoadEmojis/>;
}

