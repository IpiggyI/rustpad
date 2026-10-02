import { Icon, IconButton } from "@chakra-ui/react";
import { useRef } from "react";
import { VscCloudUpload } from "react-icons/vsc";

import { IMAGE_ACCEPT } from "./imagePaste";

function ImageUploadButton({
  onUpload,
  disabled,
}: {
  onUpload: (files: File[]) => void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        aria-label="Upload image"
        title="Upload image"
        icon={<Icon as={VscCloudUpload} />}
        size="xs"
        variant="ghost"
        isDisabled={disabled}
        onClick={() => input.current?.click()}
      />
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          onUpload(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </>
  );
}

export default ImageUploadButton;
