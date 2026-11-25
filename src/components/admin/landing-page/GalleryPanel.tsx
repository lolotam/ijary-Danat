import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ImageSourceInput } from "@/components/admin/ImageSourceInput";
import { GalleryTable } from "@/components/admin/landing-page/GalleryTable";
import {
  type LandingMedia,
  useCreateLandingMedia,
  useDeleteLandingMedia,
  useUpdateLandingMedia,
} from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { mimeTypeFromPath } from "@/lib/imageCompression";

interface GalleryPanelProps {
  mediaItems: LandingMedia[] | undefined;
  canUploadLandingImages: boolean;
  landingUploadHint: string | undefined;
}

/**
 * لوحة معرض الصور: رفع صور المعرض وإظهارها أو إخفاؤها وحذفها.
 *
 * Extracted unchanged from the landing-page settings route (audit M13, plan
 * row 6.7). The gallery lists every media row opted into the public gallery,
 * including shop and slide images, so it takes the full media list.
 */
export function GalleryPanel({
  mediaItems,
  canUploadLandingImages,
  landingUploadHint,
}: GalleryPanelProps) {
  const { t } = useI18n();
  const createMedia = useCreateLandingMedia();
  const updateMedia = useUpdateLandingMedia();
  const deleteMedia = useDeleteLandingMedia();

  const [mediaDialogOpen, setMediaDialogOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [galleryDisplayOrder, setGalleryDisplayOrder] = useState(0);

  const galleryItems =
    mediaItems
      ?.filter((m) => m.show_in_gallery === true)
      .slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)) ?? [];

  // Dedicated gallery uploads (no titles/CTAs — image + order only)
  const onAddGalleryImage = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!mediaUrl.trim()) {
      toast.error(t("landingSettings.enterAUrlOrUpload"));
      return;
    }
    try {
      const nextOrder =
        galleryDisplayOrder ||
        (galleryItems.length ? Math.max(...galleryItems.map((m) => m.display_order ?? 0)) + 1 : 1);
      await createMedia.mutateAsync({
        storage_path: mediaUrl.trim(),
        mime_type: mimeTypeFromPath(mediaUrl.trim()),
        category: "gallery",
        alt_ar: "",
        alt_en: "",
        show_in_gallery: true,
        is_active: true,
        display_order: nextOrder,
      });
      toast.success(t("landingSettings.galleryImageAdded"));
      setMediaDialogOpen(false);
      setMediaUrl("");
      setGalleryDisplayOrder(0);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const onDeleteMedia = async (id: string) => {
    if (!confirm(t("landingSettings.deleteThisGalleryPhoto"))) return;
    try {
      await deleteMedia.mutateAsync(id);
      toast.success(t("landingSettings.photoDeleted"));
    } catch {
      toast.error(t("landingSettings.failed"));
    }
  };

  const onToggleGalleryItem = async (id: string, show: boolean) => {
    try {
      await updateMedia.mutateAsync({ id, updates: { show_in_gallery: show } });
      toast.success(
        show
          ? t("landingSettings.imageShownInGallery")
          : t("landingSettings.imageHiddenFromGallery"),
      );
    } catch (err: any) {
      toast.error(err.message || "Error");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row justify-between items-center">
        <div>
          <CardTitle>{t("landingSettings.photoGallery")}</CardTitle>
          <CardDescription>{t("landingSettings.uploadDedicatedGalleryPhotosHere")}</CardDescription>
        </div>
        <Dialog
          open={mediaDialogOpen}
          onOpenChange={(open) => {
            setMediaDialogOpen(open);
            if (!open) {
              setMediaUrl("");
              setGalleryDisplayOrder(0);
            } else {
              setGalleryDisplayOrder(
                galleryItems.length
                  ? Math.max(...galleryItems.map((m) => m.display_order ?? 0)) + 1
                  : 1,
              );
            }
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1 ml-1" />
              {t("landingSettings.addImage")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("landingSettings.addGalleryImage")}</DialogTitle>
              <DialogDescription>{t("landingSettings.uploadOnlyNoTitleOr")}</DialogDescription>
            </DialogHeader>
            <form onSubmit={onAddGalleryImage} className="space-y-4">
              <div className="space-y-2">
                <Label>{t("landingSettings.imageUploadOrUrl")}</Label>
                <ImageSourceInput
                  value={mediaUrl}
                  onChange={setMediaUrl}
                  bucket="landing"
                  canUpload={canUploadLandingImages}
                  uploadHint={landingUploadHint}
                  folder="gallery"
                  placeholder={t("landingSettings.imageUrlOrUploadA")}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("landingSettings.displayOrder")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={galleryDisplayOrder}
                  onChange={(ev) => setGalleryDisplayOrder(Number(ev.target.value) || 0)}
                />
              </div>
              <DialogFooter>
                <Button type="submit">{t("common.save")}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        <GalleryTable
          items={galleryItems}
          onToggleGalleryItem={onToggleGalleryItem}
          onDeleteMedia={onDeleteMedia}
        />
      </CardContent>
    </Card>
  );
}
